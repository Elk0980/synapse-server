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
     только отправленный снимок, добавленное за это время остаётся.

   PALITRA-WEBCHAT-PHASEC 14.10.2026 — чат заявки на сайте:
   - до POST заявки, в том же тайм-ауте: сессия аккаунта магазина (её CSRF есть и у гостя) → сессия чата
     POST /api/customer-chat/session; CSRF чата — только в памяти, отдельным заголовком X-Palitra-Chat-CSRF, не вместо
     X-CSRF-Token аккаунта; тело заявки прежнее, без полей чата и входа;
   - неизвестный исход или отказ подготовки чата — заявку не отправляем (ни с чатом, ни без), корзина и поля остаются;
     прежнее оформление без чата — только при явном ответе сервера «чат выключен» до POST либо явной кнопкой покупателя
     после 409 CHAT_DISABLED (тот же requestId, без автоматического второго POST);
   - чат принятой заявки — только подтверждённый сервером chat.threadId; ссылка в Telegram — только ответ сервера в
     строгом формате c_; START за клиента не отправляется. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./price-format.js') : root.PalitraPriceFormat);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.mount(root);
}(typeof window === 'undefined' ? null : window, function (priceFormat) {
  'use strict';
  const CART_KEY = 'palitra-cart-v1';
  const REQUEST_KEY = 'palitra-order-request-v1';
  const ENDPOINT = '/api/orders';
  const PRICE_SOURCES = ['/api/price', '/data/price.json'];
  const MAX_QTY = 20, MAX_LINES = 30;
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ITEM_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
  const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  /* Ссылка «Продолжить в Telegram» приходит от сервера только к новой заявке и только когда бот Palitra
     полностью настроен. Принимается строго ссылка на t.me с одноразовым токеном; иначе ссылки просто нет. */
  const TELEGRAM_LINK = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\?start=o_[A-Za-z0-9_-]{16,62}$/;
  /* PALITRA-WEBCHAT-PHASEC: ссылка Telegram чата заявки — только ответ POST /api/customer-chat/telegram-link: https,
     ровно t.me, имя бота (…bot), один параметр start=c_ + 32 символа base64url; без учётных данных, порта и #. */
  const CHAT_TELEGRAM_LINK = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]\?start=c_[A-Za-z0-9_-]{32}$/;
  const CHAT_SESSION = '/api/customer-chat/session';
  const CHAT_LINK = '/api/customer-chat/telegram-link';
  const CHAT_CSRF_HEADER = 'X-Palitra-Chat-CSRF';
  const CHAT_LAST_KEY = 'palitra-chat-last-v1';
  const ACCOUNT_CSRF = /^[A-Za-z0-9_-]{16,128}$/;
  const CHAT_CSRF = /^[A-Za-z0-9_-]{43}$/;
  // Отказ контекста чата в ответе заявки (заявка не принята, откат на сервере): сессия чата истекла, закрыта или CSRF.
  const CHAT_SESSION_CODES = new Set(['NO_SESSION', 'EXPIRED', 'REVOKED', 'CSRF', 'CHAT']);
  const TELEGRAM_START_TEXT = 'Откроется Telegram. Нажмите «Начать», чтобы связать переписку с этой заявкой.';
  const LINK_REASONS = {
    BOT_DISABLED: 'Telegram для магазина пока не подключён — пишите в чате на сайте.',
    BRIDGE_NOT_READY: 'Telegram сейчас недоступен — пишите в чате на сайте, менеджер ответит там.',
    RATE_LIMITED: 'Слишком много ссылок подряд — попробуйте через несколько минут.',
    session: 'Сессия чата закончилась — откройте «Чат на сайте».',
    invalid: 'Сервер вернул непроверенную ссылку — Telegram не открываем. Пишите в чате на сайте.',
    network: 'Ссылку на Telegram получить не удалось. Заявка принята — попробуйте ещё раз.'
  };
  function isChatTelegramLink(value) {
    if (typeof value !== 'string' || !CHAT_TELEGRAM_LINK.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 't.me' && !url.port && !url.username && !url.password && !url.hash
        && [...url.searchParams.keys()].join(',') === 'start' && /^c_[A-Za-z0-9_-]{32}$/.test(url.searchParams.get('start') || '');
    } catch (_) { return false; }
  }
  const chatPath = (threadId) => `/chat?thread=${threadId}`;
  const esc =(value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const PRICE_PATTERN = /^\s*(\d[\d\s ]*)(?:[.,](\d{1,2}))?\s*(?:руб\.?|р\.?|₽)?\s*$/i;
  const MESSAGES = {
    pending: 'Отправляем заявку…',
    network: 'Не удалось отправить заявку: сервер не ответил или нет связи. Корзина и данные сохранены — попробуйте ещё раз.',
    rate: 'Слишком много заявок подряд. Подождите несколько минут и попробуйте снова — корзина сохранена.',
    unavailable: 'Приём заявок временно недоступен. Корзина сохранена — попробуйте позже или напишите нам в Telegram.',
    mismatch: 'Состав заявки изменился с прошлой попытки. Проверьте корзину и отправьте ещё раз.',
    stale: 'Часть позиций уже недоступна в прайсе. Удалите их из корзины и отправьте заявку снова.',
    validation: 'Проверьте контакт, поля заявки и согласие — сервер не принял заявку.',
    consent: 'Для отправки заявки нужно согласие на обработку данных.',
    empty: 'Корзина пуста — добавьте позиции из прайса или каталога.',
    priceLoading: 'Загружаем прайс, чтобы сверить состав корзины. Подождите несколько секунд.',
    priceError: 'Не удалось загрузить прайс. Нажмите «Обновить прайс» и отправьте заявку снова — корзина сохранена.',
    chatUnknown: 'Чат по заявке не подготовился: сервер не ответил. Заявку не отправили — корзина и данные сохранены, попробуйте ещё раз.',
    chatRefused: 'Чат по заявке не подтвердил вход магазина. Обновите страницу и отправьте заявку ещё раз — корзина и данные сохранены.',
    chatSession: 'Сессия чата на сайте закончилась, поэтому заявку не приняли. Отправьте её ещё раз — корзина и данные сохранены.',
    chatDisabled: 'Чат на сайте сейчас выключен, поэтому заявку не приняли. Корзина и данные сохранены — можно отправить обычную заявку без чата.',
    generic:'Не удалось отправить заявку. Данные сохранены — попробуйте ещё раз.'
  };

  /* ---------- способ и время получения (условия Дарьи 10.10.2026) ----------
     Сервер получает только существующие поля deliveryAddress/deliveryDate/deliveryInterval/comment:
     способ записывается понятным текстом, новых полей API не добавляется. */
  const PICKUP_POINT = 'г. Подольск, ул. Генерала Стрельбицкого, 3, 2 этаж';
  const FULFILLMENT = {
    delivery: { label: 'Доставка' },
    pickup: { label: 'Самовывоз', address: `Самовывоз: ${PICKUP_POINT}` },
    courier: { label: 'Курьер покупателя', address: `Курьер покупателя: заберёт заказ, ${PICKUP_POINT}` }
  };
  const INTERVALS = {
    '10-12': '10:00–12:00', '12-14': '12:00–14:00', '14-16': '14:00–16:00',
    '16-18': '16:00–18:00', '18-20': '18:00–20:00', '20-22': '20:00–22:00',
    night: 'Ночной 23:00–10:00 — стоимость согласовать', other: 'Другое время — согласовать с менеджером'
  };
  /* Самовывоз и курьер покупателя — в рабочее время 09:00–21:00: 20–22 и ночь не предлагаются. */
  const INTERVALS_FOR = {
    delivery: ['10-12', '12-14', '14-16', '16-18', '18-20', '20-22', 'night', 'other'],
    pickup: ['10-12', '12-14', '14-16', '16-18', '18-20', 'other'],
    courier: ['10-12', '12-14', '14-16', '16-18', '18-20', 'other']
  };
  const MIN_DELIVERY_KOPECKS = 350000;
  const METHOD_PREFIX = 'Способ получения:', TIME_PREFIX = 'Удобное время:';
  const intervalsFor = (method) => (INTERVALS_FOR[method] || []).slice();
  /* Служебная строка в начале комментария; повтор сборки или такая же строка клиента не удваиваются. */
  function withLine(comment, prefix, value) {
    const rest = String(comment || '').split('\n').filter((line) => !line.trim().startsWith(prefix));
    return [`${prefix} ${value}`, ...rest].join('\n').trim();
  }
  /* Подсказка не блокирует заявку: при сумме меньше минимума менеджер предложит самовывоз или курьера. */
  function fulfillmentHint(method, view) {
    if (method === 'pickup') return `Самовывоз: ${PICKUP_POINT}. Ежедневно 09:00–21:00, без минимальной суммы.`;
    if (method === 'courier') return `Подготовим заказ к приезду вашего курьера: ${PICKUP_POINT}, ежедневно 09:00–21:00.`;
    const base = 'Подольск — от 350 ₽, Москва — от 650 ₽; точную стоимость менеджер рассчитает по адресу и объёму заказа. Нашу доставку оформляем для заказов от 3 500 ₽.';
    if (view && view.ready && view.knownTotal > 0 && view.knownTotal < MIN_DELIVERY_KOPECKS) {
      return `${base} Сейчас по известным ценам ${formatRub(view.knownTotal)}: можно выбрать самовывоз или курьера покупателя — или отправить заявку, менеджер предложит вариант.`;
    }
    return base;
  }

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
        if (item && typeof item.id === 'string' && !index.has(item.id)) index.set(item.id, { title: item.title || item.id, price: parsePrice(item.price),
          priceText: priceFormat ? priceFormat.format(item.price) : String(item.price ?? '').trim(), photo: coverOf(item) });
      }
    }
    return index;
  }
  /* Фото строки корзины (замечание Дарьи 12.10.2026) — то же первое фото, что у товара в каталоге: обложка photo,
     без неё — первый допустимый кадр gallery. /api/assets/* показывается с palitra-love.ru, как в price-render.js.
     Принимается только https:// или путь сайта «/…» (не «//»), без управляющих символов и обратной косой черты. */
  const PHOTO_ORIGIN = 'https://palitra-love.ru';
  function photoUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) return '';
    const url = raw.startsWith('/api/assets/') ? PHOTO_ORIGIN + raw : raw;
    if (url.startsWith('/') && !url.startsWith('//')) return url;
    if (!/^https:\/\//i.test(url)) return '';
    try { return new URL(url).protocol === 'https:' ? url : ''; } catch (_) { return ''; }
  }
  function coverOf(item) {
    const cover = photoUrl(item.photo);
    if (cover) return cover;
    for (const photo of Array.isArray(item.gallery) ? item.gallery : []) { const url = photoUrl(photo); if (url) return url; }
    return '';
  }
  function parsePrice(value) {
    const match = PRICE_PATTERN.exec(String(value ?? ''));
    if (!match) return null;
    const rubles = Number(match[1].replace(/[\s ]/g, ''));
    const kopecks = Number((match[2] || '0').padEnd(2, '0'));
    return Number.isSafeInteger(rubles) ? rubles * 100 + kopecks : null;
  }
  const formatRub = priceFormat?.formatRub || ((kopecks) => `${Math.floor(kopecks / 100).toLocaleString('ru-RU')}${kopecks % 100 ? `,${String(kopecks % 100).padStart(2, '0')}` : ''} ₽`);
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
      return { ...item, title: entry.title, price: entry.price, priceText: entry.priceText, photo: entry.photo || '', missing: false, pending: false };
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
    const modern = fields.contactChannel !== undefined;
    const channel = String(modern ? fields.contactChannel : 'phone');
    let contact = String(fields.contact || '').trim();
    let telegramUsername = '';
    if (modern) {
      if (!['phone', 'telegram', 'whatsapp', 'max'].includes(channel)) invalid('contactChannel', 'Выберите способ связи.');
      if (channel === 'telegram') {
        telegramUsername = String(fields.telegramUsername || contact).trim().replace(/^@/, '');
        if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegramUsername)) invalid('telegramUsername', 'Укажите Telegram-ник: например, @username.');
        contact = telegramUsername = '@' + telegramUsername.toLowerCase();
      } else if (channel === 'phone' || channel === 'whatsapp') {
        const digits = normalizePhone(contact);
        if (contact.length > 32 || !/^[+\d\s().-]+$/.test(contact) || digits.length < 10 || digits.length > 15) invalid('contact', 'Укажите номер телефона с кодом.');
      } else {
        if (!contact || contact.length > 100 || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(contact)
          || (/:/.test(contact) && !/^https:\/\//i.test(contact))) invalid('contact', 'Укажите телефон, имя или HTTPS-ссылку для связи в MAX.');
        if (/^https:\/\//i.test(contact)) {
          try { const url = new URL(contact); if (!url.hostname || url.username || url.password) throw new Error(); }
          catch (_) { invalid('contact', 'Проверьте ссылку для связи в MAX.'); }
        }
      }
    } else {
      const digits = normalizePhone(phone);
      if (phone.length > 32 || digits.length < 10 || digits.length > 15) invalid('phone', 'Укажите номер телефона с кодом.');
    }
    if (comment.length > 1000) invalid('comment', 'Сократите комментарий до 1000 символов.');
    if (fields.consent !== true) invalid('consent', MESSAGES.consent);
    if (kind === 'cart' && (!items.length || items.length > MAX_LINES)) invalid('items', MESSAGES.empty);
    const payload = { kind, name, phone, comment, consent: true,
      items: kind === 'cart' ? items.map((item) => ({ id: item.id, qty: item.qty })) : [],
      page: location.origin + location.pathname, utm: campaign(location), website: String(fields.website || '') };
    if (modern) {
      delete payload.phone;
      Object.assign(payload, { contactChannel: channel, contact });
      if (telegramUsername) payload.telegramUsername = telegramUsername;
      if (kind === 'cart') {
        const date = String(fields.deliveryDate || '').trim();
        if (!isIsoDate(date)) invalid('deliveryDate', 'Укажите дату получения заказа.');
        if (fields.fulfillment !== undefined) {
          // Форма с выбором способа: адрес нужен только доставке, время — из списка для способа.
          const method = String(fields.fulfillment);
          if (!Object.hasOwn(FULFILLMENT, method)) invalid('fulfillment', 'Выберите способ получения.');
          const slot = String(fields.deliveryInterval || '').trim();
          if (!INTERVALS_FOR[method].includes(slot)) invalid('deliveryInterval', method === 'delivery'
            ? 'Выберите интервал доставки.' : 'Выберите время получения с 09:00 до 21:00 или «Другое время».');
          let address = FULFILLMENT[method].address;
          if (method === 'delivery') {
            address = String(fields.deliveryAddress || '').trim();
            if (!address || address.length > 500) invalid('deliveryAddress', 'Укажите адрес доставки, до 500 символов.');
          }
          const withMethod = withLine(comment, METHOD_PREFIX, FULFILLMENT[method].label);
          if (withMethod.length > 1000) invalid('comment', 'Сократите пожелания: вместе со способом получения — не больше 1000 символов.');
          Object.assign(payload, { comment: withMethod, deliveryAddress: address, deliveryDate: date, deliveryInterval: INTERVALS[slot] });
        } else {
          // Прежняя форма без выбора способа: свободный адрес и время, как раньше.
          const address = String(fields.deliveryAddress || '').trim();
          const interval = String(fields.deliveryInterval || '').trim();
          if (!address || address.length > 500) invalid('deliveryAddress', 'Укажите адрес доставки или самовывоз, до 500 символов.');
          if (!interval || interval.length > 80) invalid('deliveryInterval', 'Укажите удобное время, до 80 символов.');
          Object.assign(payload, { deliveryAddress: address, deliveryDate: date, deliveryInterval: interval });
        }
      }
    }
    if (kind === 'request') {
      // Заявка на подбор: дата и время необязательны, клиент может ещё ничего не выбрать.
      const occasion = String(fields.occasion || '').trim(), date = String(fields.date || '').trim();
      const slot = String(fields.interval || '').trim();
      if (occasion) payload.occasion = occasion.slice(0, 80);
      if (date) {
        if (!isIsoDate(date)) invalid('date', 'Проверьте дату или оставьте поле пустым.');
        payload.date = date;
      }
      if (slot) {
        if (!INTERVALS_FOR.delivery.includes(slot)) invalid('interval', 'Выберите время из списка или оставьте поле пустым.');
        payload.comment = withLine(payload.comment, TIME_PREFIX, INTERVALS[slot]);
        if (payload.comment.length > 1000) invalid('comment', 'Сократите пожелания: вместе со временем — не больше 1000 символов.');
      }
    }
    return payload;
  }
  function isIsoDate(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  }
  /* Отпечаток смысла заявки: состав + контакты + комментарий. Хранится только его хеш (не контакты). */
  async function fingerprint(payload, subtle) {
    const items = [...payload.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const channel = payload.contactChannel || 'phone';
    const contact = payload.contactChannel ? payload.contact : payload.phone;
    const material = JSON.stringify({ kind: payload.kind, name: payload.name,
      contactChannel: channel, contact: ['phone', 'whatsapp'].includes(channel) ? normalizePhone(contact) : contact,
      comment: payload.comment, items, occasion: payload.occasion || '', date: payload.date || '',
      deliveryAddress: payload.deliveryAddress || '', deliveryDate: payload.deliveryDate || '', deliveryInterval: payload.deliveryInterval || '' });
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
  const chatError = (code, status) => Object.assign(new Error(code), { code, status: status || 0 });
  /* PALITRA-CHECKOUT 13.10.2026 + PHASEC: сессия штатного аккаунта магазина (GET /api/draft-account/session, same-origin).
     CSRF есть и у гостя: он нужен, чтобы открыть чат заявки; вошедшему покупателю он, как раньше, ещё и закрепляет заявку за
     аккаунтом (X-CSRF-Token — только при data.user). Штатный AccountService при 200 всегда выдаёт CSRF и гостю, поэтому
     200 без корректного CSRF (нет поля, пусто, коротко, не строка) — не «чат выключен», а неподтверждённая сессия:
     CHAT_REFUSED, заявка не уходит (repair I01). Нет ответа, не 200 или нечитаемо — CHAT_UNKNOWN. Личность определяет
     сервер по cookie и CSRF, не страница. */
  async function accountSession(win, signal) {
    let res, data = null;
    try {
      res = await win.fetch('/api/draft-account/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal });
      data = await res.json();
    } catch (_) { throw chatError('CHAT_UNKNOWN'); }
    if (!res || res.status !== 200 || !data || typeof data !== 'object') throw chatError('CHAT_UNKNOWN', res && res.status);
    if (typeof data.csrf !== 'string' || !ACCOUNT_CSRF.test(data.csrf)) throw chatError('CHAT_REFUSED', res.status);
    return { csrf: data.csrf, user: Boolean(data.user) };
  }
  /* Сессия чата до заявки: POST /api/customer-chat/session {} с CSRF аккаунта; cookie чата ставит только сервер.
     - 200 ok + csrfToken → заявка с чатом (CSRF чата — только в памяти страницы);
     - явное «чат выключен» обработчика чата: так принятый HTTP PhaseB отвечает при выключенном флаге — ровно
       404 application/json {ok:false, code:'NOT_FOUND'}; либо code CHAT_DISABLED → прежнее оформление без чата;
     - всё остальное (сеть, 408/5xx, 401/403, другой 404, HTML, нечитаемо) → заявку не отправляем. */
  async function chatSession(win, accountCsrf, signal) {
    let res, data = null;
    try {
      res = await win.fetch(CHAT_SESSION, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': accountCsrf }, body: '{}' });
    } catch (_) { throw chatError('CHAT_UNKNOWN'); }
    const isJson = /^application\/json\b/i.test(String((res.headers && res.headers.get('content-type')) || ''));
    try { data = isJson ? await res.json() : null; } catch (_) { data = null; }
    if (res.status === 200 && data && data.ok === true && typeof data.csrfToken === 'string' && CHAT_CSRF.test(data.csrfToken)) return { mode: 'chat', csrf: data.csrfToken };
    if (data && data.ok === false && (data.code === 'CHAT_DISABLED' || (res.status === 404 && data.code === 'NOT_FOUND'))) return { mode: 'off', csrf: '' };
    // 401/403 — сессия или CSRF магазина не подтверждены; прочее — исход подготовки неизвестен.
    throw chatError(res.status === 401 || res.status === 403 ? 'CHAT_REFUSED' : 'CHAT_UNKNOWN', res.status);
  }
  /* Отправка: успех только при 201/200 с целым orderId. Таймаут охватывает подготовку (аккаунт, чат) и чтение тела
     ответа: зависшее тело не оставляет форму заблокированной. options.legacy — явный выбор покупателя после
     409 CHAT_DISABLED: прежняя заявка без чата (сбой чтения аккаунта тогда, как раньше, — гостевая заявка). */
  async function send(win, payload, options = {}) {
    const controller = new win.AbortController();
    const abortError = Object.assign(new Error('network'), { code: 'NETWORK' });
    let abortReject = () => {};
    const aborted = new Promise((_, reject) => { abortReject = reject; });
    aborted.catch(() => {});
    const timeout = win.setTimeout(() => { controller.abort(); abortReject(abortError); }, options.timeoutMs || 15000);
    let posted = false;
    try {
      let response, chat = { mode: 'legacy', csrf: '' };
      try {
        let account;
        try { account = await Promise.race([accountSession(win, controller.signal), aborted]); }
        catch (error) { if (!options.legacy || error === abortError) throw error; account = { csrf: '', user: false }; }
        // Обычная отправка всегда готовит чат (корректный CSRF аккаунта проверен выше); без чата — только точное
        // «чат выключен» из chatSession или явный выбор покупателя options.legacy.
        if (!options.legacy) chat = await Promise.race([chatSession(win, account.csrf, controller.signal), aborted]);
        const headers = { 'Content-Type': 'application/json', ...(account.user ? { 'X-CSRF-Token': account.csrf } : {}),
          ...(chat.mode === 'chat' ? { [CHAT_CSRF_HEADER]: chat.csrf } : {}) };
        posted = true;
        response = await Promise.race([win.fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers, body: JSON.stringify(payload), signal: controller.signal }), aborted]);
      } catch (error) {
        // До POST заявка точно не уходила: сбой подготовки чата — отдельный понятный отказ, не «заявка не дошла».
        if (!posted) throw error && error.code && error !== abortError ? error : chatError('CHAT_UNKNOWN');
        throw abortError;
      }
      let body = null;
      try { body = await Promise.race([response.json(), aborted]); } catch (error) { if (error === abortError) throw error; body = null; }
      if ((response.status === 201 || response.status === 200) && body && body.ok === true && Number.isSafeInteger(body.orderId) && body.orderId > 0) {
        const telegramUrl = body.telegram && typeof body.telegram.url === 'string' && TELEGRAM_LINK.test(body.telegram.url) ? body.telegram.url : '';
        // Чат — только подтверждённый сервером chat.threadId этой сессии; номер заявки доступа не даёт.
        const threadId = chat.mode === 'chat' && body.chat && Number.isSafeInteger(body.chat.threadId) && body.chat.threadId > 0 ? body.chat.threadId : null;
        return { orderId: body.orderId, duplicate: body.duplicate === true, message: typeof body.message === 'string' ? body.message : '', telegramUrl,
          threadId, chatCsrf: threadId ? chat.csrf : '' };
      }
      let code = body && typeof body.code === 'string' ? body.code : response.status === 429 ? 'RATE_LIMITED' : response.status === 409 ? 'REQUEST_MISMATCH' : response.status === 503 ? 'ORDERS_UNAVAILABLE' : 'HTTP';
      if (chat.mode === 'chat' && CHAT_SESSION_CODES.has(code)) code = 'CHAT_SESSION';
      throw Object.assign(new Error(code), { code, status: response.status, itemId: body && body.itemId });
    } finally { win.clearTimeout(timeout); }
  }
  /* Ссылка «Открыть Telegram» собственного чата заявки: только ответ сервера и только строгий формат c_.
     Сбой ссылки не трогает принятую заявку и не повторяет её отправку. */
  async function chatTelegramLink(win, chatCsrf, threadId, timeoutMs = 10000) {
    const controller = new win.AbortController();
    const timer = win.setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res, data = null;
      try {
        res = await win.fetch(CHAT_LINK, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', [CHAT_CSRF_HEADER]: chatCsrf }, body: JSON.stringify({ threadId }) });
        data = await res.json();
      } catch (_) { return { url: '', reason: LINK_REASONS.network }; }
      if (res.status === 200 && data && data.ok === true) return isChatTelegramLink(data.url) ? { url: data.url, reason: '' } : { url: '', reason: LINK_REASONS.invalid };
      const code = data && typeof data.code === 'string' ? data.code : '';
      return { url: '', reason: Object.hasOwn(LINK_REASONS, code) ? LINK_REASONS[code] : res.status === 401 ? LINK_REASONS.session : LINK_REASONS.network };
    } finally { win.clearTimeout(timer); }
  }
  function errorMessage(error) {
    switch (error.code) {
      case 'CHAT_UNKNOWN': return MESSAGES.chatUnknown;
      case 'CHAT_REFUSED': return MESSAGES.chatRefused;
      case 'CHAT_SESSION': return MESSAGES.chatSession;
      case 'CHAT_DISABLED': return MESSAGES.chatDisabled;
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
      const summary = form.querySelector('[data-request-context]');
      if (summary) { summary.textContent = comment.value; summary.hidden = false; }
    }
    try { session.removeItem(DRAFT_KEY); } catch (_) { /* недоступно */ }
    return true;
  }

  /* ---------- окно «Заявка принята» (ORDER_SUCCESS 13.10.2026) ----------
     Одно общее окно <dialog data-order-success-dialog> для корзины и формы подбора. Открывается только поверх уже
     принятой заявки — результата send() (201 или идемпотентный 200, ok:true, положительный orderId). Тексты — только
     textContent. «Написать менеджеру» — только проверенная ссылка body.telegram.url (TELEGRAM_LINK), без догадок.
     Закрытие (кнопки, Escape, фон) ничего не отправляет и не сбрасывает; сбой окна не превращает успех в ошибку.
     Стили только для классов .palitra-order-success* — одним <style>, при первом показе. */
  const SUCCESS_TEXT = 'Менеджер свяжется с вами, чтобы согласовать заказ.';
  const SUCCESS_STYLE_ID = 'palitra-order-success-style';
  const SUCCESS_CSS = [
    '.palitra-order-success{box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);margin:auto;padding:0;border:0;border-radius:28px;background:#fffdf8;color:#302f2a;box-shadow:0 24px 60px rgba(48,47,42,.28);overflow:auto;overscroll-behavior:contain;font-family:\'Nunito Sans\',Arial,sans-serif;font-style:normal;text-align:left}',
    '.palitra-order-success:not([open]){display:none}',
    '.palitra-order-success::backdrop{background:rgba(48,47,42,.45)}',
    '.palitra-order-success.is-fallback[open]{position:fixed;inset:0;z-index:2147483000;display:block;height:fit-content;box-shadow:0 0 0 100vmax rgba(48,47,42,.45),0 24px 60px rgba(48,47,42,.28)}',
    '.palitra-order-success .palitra-order-success__box{position:relative;display:grid;gap:12px;padding:32px 28px 28px}',
    '.palitra-order-success .palitra-order-success__close{position:absolute;top:10px;right:10px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:44px;height:44px;min-width:44px;min-height:44px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:#302f2a;font:400 28px/1 Arial,sans-serif;box-shadow:none;cursor:pointer}',
    '.palitra-order-success .palitra-order-success__close:hover{background:#f1ede3}',
    '.palitra-order-success .palitra-order-success__title{margin:0;padding-right:40px;font-family:inherit;font-size:clamp(22px,6vw,28px);font-weight:700;font-style:normal;line-height:1.2;letter-spacing:normal;text-transform:none;color:#302f2a;overflow-wrap:anywhere}',
    '.palitra-order-success .palitra-order-success__text,.palitra-order-success .palitra-order-success__note{margin:0;font-family:inherit;font-size:16px;line-height:1.5;color:#302f2a;overflow-wrap:anywhere}',
    '.palitra-order-success .palitra-order-success__note{font-size:15px;color:#5f5a4f}',
    '.palitra-order-success .palitra-order-success__actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}',
    '.palitra-order-success .palitra-order-success__actions>*{display:inline-flex;align-items:center;justify-content:center;flex:1 1 180px;box-sizing:border-box;max-width:100%;min-height:48px;margin:0;padding:12px 24px;border-radius:28px;font-family:inherit;font-size:16px;font-weight:700;line-height:1.2;text-align:center;text-decoration:none;text-transform:none;letter-spacing:normal;box-shadow:none;cursor:pointer}',
    '.palitra-order-success .palitra-order-success__ok{border:0;background:#69723e;color:#fff}',
    '.palitra-order-success .palitra-order-success__ok:hover{background:#5a6235}',
    '.palitra-order-success .palitra-order-success__telegram{border:2px solid #69723e;background:#fff;color:#302f2a}',
    '.palitra-order-success .palitra-order-success__telegram[hidden]{display:none}',
    '.palitra-order-success .palitra-order-success__chat,.palitra-order-success .palitra-order-success__retry{border:2px solid #69723e;background:#fff;color:#302f2a}',
    '.palitra-order-success .palitra-order-success__chat[hidden],.palitra-order-success .palitra-order-success__retry[hidden],.palitra-order-success .palitra-order-success__note[hidden]{display:none}',
    '.palitra-order-success :focus-visible{outline:3px solid #69723e;outline-offset:3px}',
    '@media(max-width:400px){.palitra-order-success .palitra-order-success__box{padding:28px 18px 20px}}',
    '@media(prefers-reduced-motion:reduce){.palitra-order-success *{transition:none}}'
  ].join('\n');

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
    // Окно товара (price-render.js) отдаёт кнопку «Перейти к оформлению» этому модулю (см. [data-checkout-id] ниже).
    doc.__palitraCheckout = true;
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
        index = data ? priceIndex(win.PalitraPrice.publicData ? win.PalitraPrice.publicData(data) : data) : null;
        priceState = index ? 'ready' : 'error';
        return index;
      }, () => { priceState = 'error'; return null; }).finally(() => { indexPromise = null; });
      return indexPromise;
    };
    const updateCount = () => { const count = cart.count(); for (const node of counters) node.textContent = String(count); };
    updateCount();
    const formSyncs = [];
    /* Фото строки: пока прайс грузится — нейтральное место той же величины; нет фото — «Фото пока нет». */
    const PHOTO_EMPTY = '<span class="cart-photo cart-photo--empty">Фото пока нет</span>';
    const cartPhoto = (line) => {
      if (line.pending && priceState !== 'error') return '<span class="cart-photo cart-photo--pending" aria-hidden="true"></span>';
      if (line.pending || line.missing || !line.photo) return PHOTO_EMPTY;
      return `<span class="cart-photo"><img class="cart-photo__img" src="${esc(line.photo)}" alt="${esc(line.title)}" loading="lazy" decoding="async" width="96" height="120"></span>`;
    };
    // Ошибка загрузки не всплывает — ловится на перехвате одним обработчиком, без inline onerror.
    if (panel) panel.addEventListener('error', (event) => {
      const img = event.target;
      if (!img || !img.classList || !img.classList.contains('cart-photo__img')) return;
      const box = img.parentNode;
      if (box) { box.classList.add('cart-photo--empty'); box.textContent = 'Фото пока нет'; }
    }, true);

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
        list.innerHTML = view.lines.map((line) => `<div class="cart-line cart-line--photo${line.missing ? ' cart-line--missing' : ''}${line.pending ? ' cart-line--pending' : ''}" data-cart-line="${esc(line.id)}">
          ${cartPhoto(line)}<div class="cart-line__info"><b>${line.pending ? 'Позиция прайса' : esc(line.title)}</b><span>${line.pending ? (priceState === 'error' ? 'Прайс не загружен' : 'Загружаем прайс…') : line.missing ? 'Позиция сейчас недоступна — удалите её' : line.price === null ? esc(line.priceText || 'Цена уточняется') : `${formatRub(line.price)} × ${line.qty} = ${formatRub(line.price * line.qty)}`}</span></div>
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
      // Подсказка о минимуме доставки зависит от суммы корзины.
      for (const sync of formSyncs) sync();
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
    /* «Перейти к оформлению» в окне товара (14.10.2026): кнопка несёт настоящий id открытого товара (data-checkout-id из
       data-id карточки). Товар уже в корзине — количество не меняется (повторное нажатие не прибавляет); нет — одна штука.
       Цена может быть неизвестной: состав и цену сверяет сервер, как у значка корзины. Только после этого окно товара
       закрывается и открывается корзина с формой. Неверный или пустой id либо полная корзина — оформление не
       открывается, в окне честная строка; простое открытие и закрытие окна товара корзину не меняют. */
    const checkoutFromDialog = (button) => {
      const id = button.getAttribute('data-checkout-id') || '';
      const present = cart.list().some((item) => item.id === id);
      if (!present && !cart.add(id, 1)) {
        let note = button.parentNode && button.parentNode.querySelector('[data-checkout-status]');
        if (!note) {
          note = doc.createElement('p'); note.className = 'note product-checkout-status';
          note.setAttribute('role', 'status'); note.setAttribute('data-checkout-status', '');
          button.after(note);
        }
        note.textContent = ITEM_ID.test(id) && cart.list().length >= MAX_LINES
          ? `В корзине уже ${MAX_LINES} позиций — удалите лишнее в корзине, чтобы добавить этот товар.`
          : 'Не удалось добавить этот товар в корзину. Обновите страницу и попробуйте ещё раз.';
        return;
      }
      updateCount();
      // Сначала закрыть окно товара (без возврата фокуса к кнопке цены), затем открыть корзину — фокус у корзины.
      if (typeof win.CustomEvent === 'function') doc.dispatchEvent(new win.CustomEvent('palitra:product-dialog-close', { detail: { focusCart: Boolean(panel) } }));
      openCart();
    };
    doc.addEventListener('click', (event) => {
      const add = event.target.closest('[data-add]');
      if (add) {
        if (cart.add(add.dataset.id, 1)) {
          updateCount();
          if (add.hasAttribute('data-add-icon')) {
            // Кнопка-значок (карточка 05.10.2026): значок не заменяется текстом — меняется доступное имя и отметка.
            const aria = add.dataset.ariaLabel || (add.dataset.ariaLabel = add.getAttribute('aria-label') || '');
            add.classList.add('is-added'); add.setAttribute('aria-label', `В корзине: ${add.dataset.title || ''}`.trim());
            win.setTimeout(() => { add.classList.remove('is-added'); add.setAttribute('aria-label', aria); }, 1500);
          } else {
            // Подпись текстовой кнопки задаёт разметка («Купить»); после подтверждения возвращаем исходную.
            const label = add.dataset.label || (add.dataset.label = add.textContent);
            add.classList.add('is-added'); add.textContent = 'В корзине';
            win.setTimeout(() => { add.classList.remove('is-added'); add.textContent = label; }, 1500);
          }
          if (panel && !panel.hidden) renderItems();
        }
        return;
      }
      const checkout = event.target.closest('[data-checkout-id]');
      if (checkout) { event.preventDefault(); checkoutFromDialog(checkout); return; }
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

    /* Окно «Заявка принята»: создаётся один раз при первом успехе, общее для всех форм. */
    let successUi = null, successReturn = null;
    const isVisible = (node) => Boolean(node && node.isConnected && !node.disabled && !node.closest('[hidden]')
      && typeof node.getClientRects === 'function' && node.getClientRects().length);
    // Фокус после закрытия: строка статуса формы, затем видимый заголовок корзины/страницы, затем main.
    const restoreFocus = () => {
      const from = successReturn; successReturn = null;
      const candidates = [from && from.status, from && from.form && from.form.querySelector('button:not([type=button])'),
        panel && panel.querySelector('h2'), doc.querySelector('main h1'), doc.querySelector('main')];
      for (const node of candidates) {
        if (!isVisible(node)) continue;
        try {
          if (!node.hasAttribute('tabindex') && !/^(?:A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) node.setAttribute('tabindex', '-1');
          node.focus();
        } catch (_) { /* фокус не обязателен */ }
        return;
      }
    };
    const ensureSuccessUi = () => {
      if (successUi) return successUi;
      if (!doc.getElementById(SUCCESS_STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = SUCCESS_STYLE_ID;
        style.textContent = SUCCESS_CSS;
        (doc.head || doc.body).append(style);
      }
      const dialog = doc.createElement('dialog');
      dialog.className = 'palitra-order-success';
      dialog.setAttribute('data-order-success-dialog', '');
      dialog.setAttribute('aria-labelledby', 'palitra-order-success-title');
      dialog.setAttribute('aria-describedby', 'palitra-order-success-text');
      const box = doc.createElement('div'); box.className = 'palitra-order-success__box';
      const close = doc.createElement('button'); close.type = 'button'; close.className = 'palitra-order-success__close';
      close.setAttribute('aria-label', 'Закрыть окно'); close.textContent = '×';
      const title = doc.createElement('h2'); title.id = 'palitra-order-success-title'; title.className = 'palitra-order-success__title';
      const text = doc.createElement('p'); text.id = 'palitra-order-success-text'; text.className = 'palitra-order-success__text';
      const note = doc.createElement('p'); note.className = 'palitra-order-success__note';
      // PHASEC: строка о Telegram чата заявки (получаем ссылку / «Нажмите “Начать”» / точная причина отказа).
      const linkNote = doc.createElement('p'); linkNote.className = 'palitra-order-success__note'; linkNote.setAttribute('role', 'status'); linkNote.hidden = true;
      const actions = doc.createElement('div'); actions.className = 'palitra-order-success__actions';
      // «Чат на сайте» — только при собственном чате заявки, подтверждённом сервером; обычный переход в этом окне.
      const chat = doc.createElement('a'); chat.className = 'palitra-order-success__chat'; chat.textContent = 'Чат на сайте'; chat.hidden = true;
      const telegram = doc.createElement('a'); telegram.className = 'palitra-order-success__telegram';
      telegram.target = '_blank'; telegram.rel = 'noopener noreferrer'; telegram.textContent = 'Написать менеджеру'; telegram.hidden = true;
      const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'palitra-order-success__retry';
      retry.textContent = 'Получить ссылку на Telegram ещё раз'; retry.hidden = true;
      const ok = doc.createElement('button'); ok.type = 'button'; ok.className = 'palitra-order-success__ok'; ok.textContent = 'Хорошо';
      actions.append(chat, telegram, retry, ok);
      box.append(close, title, text, note, linkNote, actions);
      dialog.append(box);
      const fallback = () => dialog.classList.contains('is-fallback');
      const closed = () => { dialog.classList.remove('is-fallback'); restoreFocus(); };
      const hide = () => {
        if (!fallback() && dialog.open && typeof dialog.close === 'function') { dialog.close(); return; } // событие close → closed
        if (dialog.hasAttribute('open')) { dialog.removeAttribute('open'); closed(); }
      };
      dialog.addEventListener('close', closed);
      close.addEventListener('click', hide);
      ok.addEventListener('click', hide);
      // Нажатие на затемнённый фон (вне содержимого окна) закрывает окно; клики внутри окна — нет.
      dialog.addEventListener('click', (event) => { if (event.target === dialog) hide(); });
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); hide(); });
      dialog.addEventListener('keydown', (event) => {
        // Escape закрывает только окно: корзина под ним не закрывается.
        if (event.key === 'Escape') { event.stopPropagation(); if (fallback()) { event.preventDefault(); hide(); } return; }
        if (event.key !== 'Tab') return; // удерживаем фокус и в native dialog, и в запасном режиме
        const items = [close, chat, telegram, retry, ok].filter((node) => !node.hidden);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      });
      retry.addEventListener('click', () => { const again = successUi && successUi.retryFor; if (again) followTelegram(again.result, again.wantsTelegram); });
      successUi = { dialog, title, text, note, linkNote, chat, telegram, retry, ok, orderId: 0, retryFor: null };
      return successUi;
    };
    const setLinkNote = (ui, text) => { ui.linkNote.textContent = text || ''; ui.linkNote.hidden = !text; };
    const showSuccess = (result, form, status, { wantsTelegram = false } = {}) => {
      if (!result || !Number.isSafeInteger(result.orderId) || result.orderId <= 0) return;
      const ui = ensureSuccessUi();
      const link = typeof result.telegramUrl === 'string' && TELEGRAM_LINK.test(result.telegramUrl) ? result.telegramUrl : '';
      const threadId = Number.isSafeInteger(result.threadId) && result.threadId > 0 ? result.threadId : null;
      ui.orderId = result.orderId; ui.retryFor = null; ui.retry.hidden = true;
      ui.title.textContent = `Заявка №${result.orderId} принята`;
      ui.text.textContent = SUCCESS_TEXT;
      ui.note.textContent = result.duplicate ? 'Эта заявка уже была принята раньше — отправлять её ещё раз не нужно.'
        : threadId ? 'Переписка по заявке — в чате на сайте: ответ менеджера появится там.'
          : link ? 'Можно сразу написать менеджеру в Telegram.' : 'Менеджер ответит по контакту, который вы указали в заявке.';
      if (threadId) { ui.chat.href = chatPath(threadId); ui.chat.hidden = false; }
      else { ui.chat.removeAttribute('href'); ui.chat.hidden = true; }
      // Прежняя ссылка o_ — сразу; ссылка c_ чата заявки — позже, только после ответа сервера (followTelegram).
      ui.telegram.textContent = 'Написать менеджеру';
      if (link) { ui.telegram.href = link; ui.telegram.hidden = false; }
      else { ui.telegram.removeAttribute('href'); ui.telegram.hidden = true; }
      setLinkNote(ui, threadId && wantsTelegram ? 'Получаем ссылку на Telegram…' : '');
      successReturn = { form, status };
      if (!ui.dialog.isConnected) doc.body.append(ui.dialog);
      if (!ui.dialog.hasAttribute('open')) {
        let modal = false;
        if (typeof ui.dialog.showModal === 'function') { try { ui.dialog.showModal(); modal = true; } catch (_) { modal = false; } }
        if (!modal) { ui.dialog.classList.add('is-fallback'); ui.dialog.setAttribute('open', ''); }
      }
      ui.ok.focus();
    };
    /* PHASEC: после принятой заявки с собственным чатом — проверенная ссылка c_ на бота. Если покупатель сам выбрал
       Telegram (способ связи снят до form.reset), окно этой заявки ещё открыто и ссылка верна — обычный переход в этом
       же окне (не window.open после await); «Начать» клиент нажимает сам. Иначе — кнопка «Открыть Telegram».
       Отказ или неверная ссылка: заявка и чат остаются принятыми, видна точная причина и кнопка повтора ссылки. */
    const followTelegram = async (result, wantsTelegram) => {
      const mine = () => (successUi && successUi.orderId === result.orderId ? successUi : null);
      if (mine()) { mine().retry.hidden = true; setLinkNote(mine(), 'Получаем ссылку на Telegram…'); }
      let outcome;
      try { outcome = await chatTelegramLink(win, result.chatCsrf, result.threadId); } catch (_) { outcome = { url: '', reason: LINK_REASONS.network }; }
      const ui = mine();
      if (!ui) return;
      if (outcome.url) {
        ui.telegram.href = outcome.url; ui.telegram.textContent = 'Открыть Telegram'; ui.telegram.hidden = false;
        setLinkNote(ui, wantsTelegram ? TELEGRAM_START_TEXT : 'Можно продолжить переписку в Telegram: «Открыть Telegram», затем «Начать».');
        if (wantsTelegram && ui.dialog.hasAttribute('open')) win.location.assign(outcome.url);
        return;
      }
      ui.telegram.removeAttribute('href'); ui.telegram.hidden = true;
      setLinkNote(ui, outcome.reason);
      ui.retryFor = { result, wantsTelegram };
      ui.retry.hidden = false;
    };
    // Вкладка помнит только безопасные номера заявки и чата — для возврата в «Чат на сайте».
    const rememberChat = (result) => {
      if (!session) return;
      try { session.setItem(CHAT_LAST_KEY, JSON.stringify({ orderId: result.orderId, threadId: result.threadId })); } catch (_) { /* недоступно */ }
    };

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
      const syncContact = () => {
        const channel = form.elements.contactChannel;
        if (!channel) return;
        const telegram = channel.value === 'telegram';
        const contact = form.elements.contact, username = form.elements.telegramUsername;
        form.querySelector('[data-contact-field]').hidden = telegram;
        form.querySelector('[data-telegram-field]').hidden = !telegram;
        contact.disabled = pending || telegram; contact.required = !telegram;
        username.disabled = pending || !telegram; username.required = telegram;
        const max = channel.value === 'max';
        contact.type = max ? 'text' : 'tel';
        contact.maxLength = max ? 100 : 32;
        contact.autocomplete = max ? 'off' : 'tel';
        form.querySelector('[data-contact-label]').textContent = max ? 'Телефон или контакт в MAX' : 'Номер телефона';
        contact.placeholder = max ? 'Телефон, имя или ссылка в MAX' : '+7 …';
      };
      form.elements.contactChannel?.addEventListener('change', syncContact);
      syncContact();
      /* Способ получения: адрес только у доставки, список времени пересобирается под способ
         (option.hidden не работает в Safari), подсказка о цене и минимуме не блокирует отправку. */
      const methods = [...form.querySelectorAll('input[name=fulfillment]')];
      const slotSelect = form.querySelector('select[name=deliveryInterval]');
      const slotChoices = slotSelect ? [...slotSelect.options].map((option) => ({ value: option.value, text: option.textContent })) : [];
      const today = () => { const d = new win.Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      for (const input of form.querySelectorAll('input[type=date][name=deliveryDate], input[type=date][name=date]')) input.min = today();
      const syncFulfillment = () => {
        if (!methods.length) return;
        const method = (methods.find((input) => input.checked) || methods[0]).value;
        const delivery = method === 'delivery';
        const addressField = form.querySelector('[data-delivery-address-field]'), address = form.elements.deliveryAddress;
        if (addressField) addressField.hidden = !delivery;
        if (address) { address.disabled = pending || !delivery; address.required = delivery; }
        if (slotSelect) {
          const allowed = intervalsFor(method), selected = slotSelect.value;
          slotSelect.replaceChildren(...slotChoices.filter((choice) => !choice.value || allowed.includes(choice.value)).map((choice) => {
            const option = doc.createElement('option'); option.value = choice.value; option.textContent = choice.text; return option;
          }));
          slotSelect.value = allowed.includes(selected) ? selected : '';
        }
        const hint = form.querySelector('[data-fulfillment-hint]');
        if (hint) hint.textContent = fulfillmentHint(method, kind === 'cart' ? describe(cart.list(), index) : null);
        const slotHint = form.querySelector('[data-interval-hint]');
        if (slotHint) {
          const slot = slotSelect ? slotSelect.value : '';
          slotHint.textContent = slot === 'night' ? 'Ночной интервал: стоимость менеджер согласует индивидуально.'
            : slot === 'other' ? 'Напишите удобное время в пожеланиях — менеджер подтвердит возможность.'
            : 'Время на сегодня подтверждает менеджер.';
        }
      };
      for (const input of methods) input.addEventListener('change', syncFulfillment);
      slotSelect?.addEventListener('change', syncFulfillment);
      formSyncs.push(syncFulfillment);
      syncFulfillment();
      const setBusy = (busy) => {
        pending = busy;
        form.setAttribute('aria-busy', String(busy));
        for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = busy;
        syncContact();
        syncFulfillment();
      };
      const message = (text, state) => { status.textContent = text; status.dataset.state = state; };
      // Ссылка в Telegram показывается только под успешной заявкой и убирается при следующей отправке.
      const dropTelegram = () => { const old = form.querySelector('[data-order-telegram]'); if (old) old.remove(); };
      const offerTelegram = (url) => {
        dropTelegram();
        if (!url) return;
        const link = doc.createElement('a');
        link.className = 'button outline order-telegram'; link.setAttribute('data-order-telegram', '');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = 'Продолжить в Telegram';
        status.after(link);
      };
      // PHASEC: под принятой заявкой с собственным чатом — ссылка «Чат по заявке на сайте» (дублирует кнопку окна).
      const dropChat = () => { const old = form.querySelector('[data-order-chat]'); if (old) old.remove(); };
      const offerChat = (threadId) => {
        dropChat();
        if (!threadId) return;
        const link = doc.createElement('a');
        link.className = 'button outline order-chat'; link.setAttribute('data-order-chat', '');
        link.href = chatPath(threadId); link.textContent = 'Чат по заявке на сайте';
        status.after(link);
      };
      // PHASEC: после 409 CHAT_DISABLED — только явная кнопка покупателя: прежняя заявка без чата тем же requestId.
      let forceLegacy = false;
      const dropLegacy = () => { const old = form.querySelector('[data-order-legacy]'); if (old) old.remove(); };
      const offerLegacy = () => {
        dropLegacy();
        const button = doc.createElement('button');
        button.type = 'button'; button.className = 'button outline order-legacy'; button.setAttribute('data-order-legacy', '');
        button.textContent = 'Отправить обычную заявку без чата';
        button.addEventListener('click', () => {
          if (pending) return;
          forceLegacy = true;
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new win.Event('submit', { cancelable: true }));
        });
        status.after(button);
      };
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (pending) return;
        // Флаг ставится до первого await: второй клик во время подготовки не создаёт второй запрос.
        pending = true;
        const legacy = forceLegacy;
        forceLegacy = false;
        const values = Object.fromEntries(new win.FormData(form));
        // PHASEC: выбранный способ связи снимается до form.reset() — по нему решается переход в Telegram после заявки.
        const wantsTelegram = String(values.contactChannel || '') === 'telegram';
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
        dropTelegram(); dropChat(); dropLegacy();
        let accepted = null;
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
          const result = await send(win, payload, { legacy });
          forgetRequest(kind, session);
          if (kind === 'cart') { cart.consume(snapshot); renderItems(); }
          form.reset();
          syncFulfillment();
          const context = form.querySelector('[data-request-context]');
          if (context) { context.hidden = true; context.textContent = ''; }
          message(result.message || `Заявка №${result.orderId} принята. Менеджер свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку.`, 'success');
          offerTelegram(result.telegramUrl);
          offerChat(result.threadId);
          if (result.threadId) rememberChat(result);
          accepted = result;
          // ORDER_SUCCESS: окно — только поверх уже принятой заявки; его сбой не превращает успех в ошибку и не повторяет отправку.
          try { showSuccess(result, form, status, { wantsTelegram }); } catch (_) { /* остаётся строка статуса формы */ }
        } catch (error) {
          if (error.code === 'REQUEST_MISMATCH') forgetRequest(kind, session);
          if (error.code === 'ITEM_UNKNOWN') { index = null; refreshPrice(); }
          message(error.code ? errorMessage(error) : MESSAGES.generic, 'error');
          if (error.code === 'CHAT_DISABLED') offerLegacy();
        } finally {
          setBusy(false);
          status.setAttribute('tabindex', '-1');
        }
        // PHASEC: ссылка в Telegram — уже после принятой заявки и вне её try: сбой не делает заявку ошибкой и не повторяет POST.
        if (accepted && accepted.threadId) {
          try { await followTelegram(accepted, wantsTelegram); } catch (_) { /* заявка и чат уже приняты */ }
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

  return { CART_KEY, REQUEST_KEY, DRAFT_KEY, ENDPOINT, MESSAGES, TELEGRAM_LINK, CHAT_TELEGRAM_LINK, isChatTelegramLink, FULFILLMENT, INTERVALS, MIN_DELIVERY_KOPECKS, intervalsFor, fulfillmentHint, withLine, createCart, readCart, priceIndex, parsePrice, describe, formatRub, buildPayload, fingerprint, requestIdFor, forgetRequest, readRequestDraft, applyRequestDraft, send, errorMessage, mount };
}));
