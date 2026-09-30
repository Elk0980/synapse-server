'use strict';

/* Заявки с сайта Palitra: публичный приём, сохранение и уведомление получателя в Telegram через
   уже существующий мост (chat опрашивает outbox по CHAT_API_KEY, токен бота остаётся в chat).
   Заказ и его outbox-задание — одна транзакция. Уведомление с неизвестным результатом никогда не
   повторяется автоматически: только явное действие владельца создаёт новое задание.
   Всё, что пришло с сайта, — недоверенные данные: состав и цены берутся из live-прайса, IP хранится
   только хешем, контакты клиента не попадают в журнал. */

const crypto = require('node:crypto');

const KINDS = new Set(['cart', 'request']);
const ORDER_STATUSES = ['accepted', 'notified', 'notify_uncertain', 'notify_failed'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const CHAT_ID = /^\d{5,20}$/;
const BODY_FIELDS = new Set(['requestId', 'kind', 'name', 'phone', 'comment', 'consent', 'items', 'occasion', 'date', 'page', 'utm', 'website',
  'contactChannel', 'contact', 'telegramUsername', 'deliveryAddress', 'deliveryDate', 'deliveryInterval']);
const CONTACT_CHANNELS = Object.freeze({ phone: 'Звонок', telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' });
const phoneDigits = (value) => { const digits = value.replace(/\D/g, ''); return digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits; };
const validPhone = (value) => value.length <= 32 && /^[+\d\s().-]+$/.test(value) && /^\d{10,15}$/.test(phoneDigits(value));
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const RATE_SHORT = { windowMs: 10 * 60 * 1000, limit: 5 };
const RATE_DAY = { windowMs: 24 * 60 * 60 * 1000, limit: 20 };
const TELEGRAM_ATTEMPTS = 3;
const TELEGRAM_LEASE = 10 * 60 * 1000;
const MAX_KOPECKS = 10 ** 13;            // защита от переполнения итога: выше — цена неизвестна
const PRICE_PATTERN = /^\s*(\d[\d\s ]*)(?:[.,](\d{1,2}))?\s*(?:руб\.?|р\.?|₽)?\s*$/i;
const JOB_PREFIX = 'order:';
const LIST_LIMIT = 100;
/* Канал доставки уведомлений о заявках: прежний бот Synapse (через мост общего чата проекта) или
   клиентский бот компании. По умолчанию — прежний; клиентский включает только владелец явно. */
const TRANSPORTS = new Set(['project_bot', 'client_bot']);
/* Состояние обработки заявки менеджером. Отдельно от статуса уведомления (site_orders.status):
   «уведомление доставлено» не значит «заявка в работе». Нет строки — заявка новая. */
const WORK_STATUSES = new Set(['new', 'in_work', 'done', 'cancelled']);
const CHECKLIST_ITEMS = Object.freeze({ photo: 'Фото готового заказа отправлено', guide: 'Памятка по шарам отправлена' });

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const shortText = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
const cleanString = (value, max, field) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(400, `Некорректное поле ${field}`, 'VALIDATION');
  const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (text.length > max) fail(400, `Слишком длинное поле ${field}`, 'VALIDATION');
  return text;
};
/* Цена прайса — строка вида «9 270 руб.». Всё, что не ровно число (пусто, «от 2 500», «договорная»),
   считается неизвестной ценой: итог по ней не считается, позиция уточняется менеджером. */
function priceKopecks(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= MAX_KOPECKS / 100 ? Math.round(value * 100) : null;
  const match = PRICE_PATTERN.exec(String(value ?? ''));
  if (!match) return null;
  const rubles = Number(match[1].replace(/[\s ]/g, ''));
  const kopecks = Number((match[2] || '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(rubles) || rubles < 0 || rubles * 100 + kopecks > MAX_KOPECKS) return null;
  return rubles * 100 + kopecks;
}
const formatRub = (kopecks) => {
  const rub = Math.floor(kopecks / 100), rest = kopecks % 100;
  return `${rub.toLocaleString('ru-RU')}${rest ? `,${String(rest).padStart(2, '0')}` : ''} ₽`;
};
const isPrivateAddress = (ip) => {
  const value = String(ip || '').replace(/^::ffff:/i, '');
  return value === '::1' || /^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(value) || /^f[cd][0-9a-f]{2}:/i.test(value) || /^fe80:/i.test(value);
};
/* Клиентский адрес: X-Forwarded-For принимается только от доверенного прокси (соединение из частной
   сети, где живёт Caddy) и только его последнее значение — то, что дописал сам прокси. */
function clientIp(request) {
  const remote = String(request.socket?.remoteAddress || '');
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (forwarded.length && isPrivateAddress(remote)) return forwarded[forwarded.length - 1].slice(0, 64);
  return remote.slice(0, 64);
}
const originOf = (request) => {
  for (const header of ['origin', 'referer']) {
    const value = String(request.headers?.[header] || '');
    if (!value) continue;
    try { return new URL(value).origin; } catch { return ''; }
  }
  return '';
};

function createSiteOrders({ db, tx, sites = {}, priceReader, ipSalt = '', now = Date.now, groupNotificationSites = [], groupReader = () => null }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_order_recipients (
      site TEXT PRIMARY KEY, company_code TEXT NOT NULL, telegram_chat_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, verified_at TEXT, last_test_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, company_code TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cart','request')),
      status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','notified','notify_uncertain','notify_failed')),
      name TEXT NOT NULL, phone TEXT NOT NULL, phone_normalized TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL, known_total INTEGER NOT NULL DEFAULT 0, unknown_count INTEGER NOT NULL DEFAULT 0,
      page TEXT NOT NULL DEFAULT '', utm_json TEXT NOT NULL DEFAULT '{}', ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, notified_at TEXT, UNIQUE(site, request_id)
    );
    CREATE TABLE IF NOT EXISTS site_order_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, company_code TEXT NOT NULL,
      order_id INTEGER REFERENCES site_orders(id), kind TEXT NOT NULL CHECK(kind IN ('order','test')),
      chat_id TEXT NOT NULL, recipient_version INTEGER NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','error')),
      attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, next_attempt_at TEXT NOT NULL,
      external_ids TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS site_order_outbox_order ON site_order_outbox(order_id, id);
    CREATE TABLE IF NOT EXISTS site_order_rate (ip_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS site_order_rate_ip ON site_order_rate(ip_hash, created_at);
    CREATE TABLE IF NOT EXISTS site_order_work (
      order_id INTEGER PRIMARY KEY REFERENCES site_orders(id), status TEXT NOT NULL CHECK(status IN ('new','in_work','done','cancelled')),
      updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_order_work_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES site_orders(id),
      status TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_order_checklist (
      order_id INTEGER NOT NULL REFERENCES site_orders(id), item TEXT NOT NULL CHECK(item IN ('photo','guide')),
      checked INTEGER NOT NULL CHECK(checked IN (0,1)), revision INTEGER NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_label TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(order_id,item)
    );
    CREATE TABLE IF NOT EXISTS site_order_checklist_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES site_orders(id),
      item TEXT NOT NULL CHECK(item IN ('photo','guide')), checked INTEGER NOT NULL CHECK(checked IN (0,1)), revision INTEGER NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_label TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(order_id,item,revision)
    );
  `);
  // Колонки канала добавляются к уже созданным таблицам: прежние строки получают прежний канал.
  const columns = (table) => new Set(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name));
  if (!columns('site_order_recipients').has('transport')) db.exec("ALTER TABLE site_order_recipients ADD COLUMN transport TEXT NOT NULL DEFAULT 'project_bot'");
  if (!columns('site_order_outbox').has('transport')) db.exec("ALTER TABLE site_order_outbox ADD COLUMN transport TEXT NOT NULL DEFAULT 'project_bot'");
  if (!columns('site_order_outbox').has('destination')) db.exec("ALTER TABLE site_order_outbox ADD COLUMN destination TEXT NOT NULL DEFAULT 'manager'");
  for (const field of ['contact_channel', 'contact', 'telegram_username', 'delivery_address', 'delivery_date', 'delivery_interval']) {
    if (!columns('site_orders').has(field)) db.exec(`ALTER TABLE site_orders ADD COLUMN ${field} TEXT NOT NULL DEFAULT ''`);
  }
  if (!columns('site_orders').has('group_required')) db.exec('ALTER TABLE site_orders ADD COLUMN group_required INTEGER NOT NULL DEFAULT 0');
  const stamp = (at = now()) => new Date(at).toISOString();
  const siteConfig = (site) => (Object.hasOwn(sites, site) ? sites[site] : null);
  const ipHash = (ip) => sha256(`${ip}|${ipSalt}`);
  const checklistEnabled = (site) => site === 'palitra' && siteConfig(site)?.companyCode === 'palitra-love';
  const groupEnabled = (site) => groupNotificationSites.includes(site);
  const groupOf = (site) => {
    const config = siteConfig(site);
    if (!config || !groupEnabled(site)) return null;
    const id = String(groupReader(config.companyCode) || '');
    return /^-\d{1,20}$/.test(id) ? { telegram_chat_id: id, version: 0, transport: 'project_bot' } : null;
  };

  /* ---------- прайс ---------- */
  function priceIndex(site) {
    let doc = null;
    try { const body = priceReader(site); doc = body ? (typeof body === 'string' ? JSON.parse(body) : body) : null; } catch { doc = null; }
    if (!doc || !Array.isArray(doc.categories)) return null;
    const index = new Map();
    for (const category of doc.categories) {
      for (const item of Array.isArray(category?.items) ? category.items : []) {
        if (item && typeof item.id === 'string' && !index.has(item.id)) {
          index.set(item.id, { title: shortText(item.title || item.id, 120), price: priceKopecks(item.price) });
        }
      }
    }
    return index;
  }

  /* ---------- валидация заявки ---------- */
  function validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Ожидался JSON-объект', 'VALIDATION');
    for (const key of Object.keys(body)) if (!BODY_FIELDS.has(key)) fail(400, `Неизвестное поле ${key}`, 'VALIDATION');
    const requestId = cleanString(body.requestId, 36, 'requestId').toLowerCase();
    if (!UUID_V4.test(requestId)) fail(400, 'Некорректный requestId', 'VALIDATION');
    if (!KINDS.has(body.kind)) fail(400, 'Некорректное поле kind', 'VALIDATION');
    const name = cleanString(body.name, 80, 'name');
    if (!name) fail(400, 'Укажите имя', 'VALIDATION');
    const structured = Object.hasOwn(body, 'contactChannel');
    let phone = cleanString(body.phone, 32, 'phone'), digits = phoneDigits(phone);
    let contactChannel = '', contact = '', telegramUsername = '';
    const deliveryAddress = cleanString(body.deliveryAddress, 500, 'deliveryAddress');
    const deliveryDate = cleanString(body.deliveryDate, 10, 'deliveryDate');
    const deliveryInterval = cleanString(body.deliveryInterval, 80, 'deliveryInterval');
    if (structured) {
      contactChannel = cleanString(body.contactChannel, 16, 'contactChannel');
      if (!Object.hasOwn(CONTACT_CHANNELS, contactChannel)) fail(400, 'Выберите способ связи', 'VALIDATION');
      contact = cleanString(body.contact, 100, 'contact');
      if (!contact) fail(400, 'Укажите контакт для связи', 'VALIDATION');
      telegramUsername = cleanString(body.telegramUsername, 33, 'telegramUsername');
      if (contactChannel === 'phone' || contactChannel === 'whatsapp') {
        if (!validPhone(contact)) fail(400, 'Укажите телефон для выбранного способа связи', 'VALIDATION');
        if (phone && (!validPhone(phone) || phoneDigits(phone) !== phoneDigits(contact))) fail(400, 'Телефон и контакт не совпадают', 'VALIDATION');
        phone = contact; digits = phoneDigits(phone);
      } else if (phone && !validPhone(phone)) fail(400, 'Некорректный дополнительный телефон', 'VALIDATION');
      if (contactChannel === 'telegram') {
        const handle = (value) => `@${value.replace(/^@/, '')}`;
        if (!/^@?[a-z][a-z0-9_]{4,31}$/i.test(contact) || (telegramUsername && (!/^@?[a-z][a-z0-9_]{4,31}$/i.test(telegramUsername) || handle(telegramUsername).toLowerCase() !== handle(contact).toLowerCase()))) fail(400, 'Укажите Telegram @ник', 'VALIDATION');
        contact = handle(contact).toLowerCase(); telegramUsername = contact;
      } else if (telegramUsername) fail(400, 'Telegram ник допустим только для Telegram', 'VALIDATION');
      if (contactChannel === 'max') {
        if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(contact) || (/:/.test(contact) && !/^https:\/\//i.test(contact))) fail(400, 'Укажите контакт MAX, без email и небезопасных ссылок', 'VALIDATION');
        if (/^https:\/\//i.test(contact)) {
          try { const url = new URL(contact); if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error(); }
          catch { fail(400, 'Некорректная ссылка MAX', 'VALIDATION'); }
        }
      }
      if (body.kind === 'cart' && (!deliveryAddress || !deliveryDate || !deliveryInterval)) fail(400, 'Укажите адрес, дату и интервал доставки', 'VALIDATION');
    } else {
      if (digits.length < 10 || digits.length > 15) fail(400, 'Укажите телефон', 'VALIDATION');
      if (['contact', 'telegramUsername', 'deliveryAddress', 'deliveryDate', 'deliveryInterval'].some((key) => body[key] !== undefined)) fail(400, 'Для новых полей укажите contactChannel', 'VALIDATION');
    }
    if (deliveryDate && !validDate(deliveryDate)) fail(400, 'Укажите действительную дату доставки', 'VALIDATION');
    if (body.consent !== true) fail(400, 'Нужно согласие на обработку данных', 'VALIDATION');
    let comment = cleanString(body.comment, 1000, 'comment');
    if (body.kind === 'request') {
      const occasion = cleanString(body.occasion, 80, 'occasion'), date = cleanString(body.date, 40, 'date');
      comment = [comment, occasion ? `Повод: ${occasion}` : '', date ? `Дата: ${date}` : ''].filter(Boolean).join('\n').slice(0, 1200);
    }
    if (!Array.isArray(body.items)) fail(400, 'Некорректное поле items', 'VALIDATION');
    if (body.kind === 'request' && body.items.length) fail(400, 'Для заявки с формы состав не передаётся', 'VALIDATION');
    if (body.kind === 'cart' && (body.items.length < 1 || body.items.length > 30)) fail(400, 'В корзине от 1 до 30 позиций', 'VALIDATION');
    const seen = new Set();
    const items = body.items.map((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ITEM_ID.test(item.id)) fail(400, 'Некорректная позиция корзины', 'VALIDATION');
      if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20) fail(400, 'Количество от 1 до 20', 'VALIDATION');
      if (seen.has(item.id)) fail(400, 'Позиция повторяется', 'VALIDATION');
      seen.add(item.id);
      return { id: item.id, qty: item.qty };
    }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = cleanString(body.page, 300, 'page');
    const utm = {};
    if (body.utm !== undefined && body.utm !== null) {
      if (typeof body.utm !== 'object' || Array.isArray(body.utm)) fail(400, 'Некорректное поле utm', 'VALIDATION');
      for (const key of UTM_FIELDS) { const value = cleanString(body.utm[key], 200, key); if (value) utm[key] = value; }
    }
    const website = cleanString(body.website, 200, 'website');
    // Отпечаток — только смысл заявки: тот же requestId с другим составом или контактом не «тот же» запрос.
    const meaning = { kind: body.kind, name, phone: digits, comment, items };
    if (structured) Object.assign(meaning, { contactChannel, contact: ['phone', 'whatsapp'].includes(contactChannel) ? digits : contact, telegramUsername, deliveryAddress, deliveryDate, deliveryInterval });
    const fingerprint = sha256(JSON.stringify(meaning));
    return { requestId, kind: body.kind, name, phone, phoneNormalized: digits, contactChannel, contact, telegramUsername, deliveryAddress, deliveryDate, deliveryInterval,
      comment, items, page, utm, honeypot: Boolean(website), fingerprint };
  }

  /* ---------- текст уведомления ---------- */
  const moscow = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function orderText(order, siteTitle) {
    const lines = [`Заявка №${order.id} · ${siteTitle} · ${moscow(order.created_at)}`, `Имя: ${order.name}`];
    if (order.contact_channel) lines.push(`Связаться через: ${CONTACT_CHANNELS[order.contact_channel]}`, `Контакт: ${order.contact}`);
    if (order.phone) lines.push(`Телефон: ${order.phone}`);
    if (order.delivery_address) lines.push(`Адрес доставки: ${order.delivery_address}`);
    if (order.delivery_date) lines.push(`Дата доставки: ${order.delivery_date}`);
    if (order.delivery_interval) lines.push(`Интервал доставки: ${order.delivery_interval}`);
    const items = JSON.parse(order.items_json);
    if (items.length) {
      lines.push('Состав:');
      for (const item of items) lines.push(`• ${item.title} × ${item.qty} — ${item.price === null ? 'цена уточняется' : formatRub(item.price * item.qty)}`);
      lines.push(`Итого по известным ценам: ${formatRub(order.known_total)}${order.unknown_count ? ` (ещё ${order.unknown_count} позиций уточняются)` : ''}`);
    } else lines.push('Заявка с формы сайта (без корзины)');
    if (order.comment) lines.push(`Комментарий: ${order.comment}`);
    if (order.page) lines.push(`Страница: ${order.page}`);
    const utm = JSON.parse(order.utm_json || '{}');
    if (Object.keys(utm).length) lines.push(`Источник: ${Object.entries(utm).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    // Длина уже ограничена валидатором (30 позиций, комментарий, utm); на части по 3500 текст делит мост
    // и не повторяет уже отправленные части — здесь ничего не обрезается.
    return lines.join('\n');
  }
  const recipientOf = (site) => db.prepare('SELECT * FROM site_order_recipients WHERE site=?').get(site) || null;
  function enqueue(site, config, kind, order, recipient, destination = 'manager') {
    const text = kind === 'test' ? `Проверка получателя заявок ${config.title}. Ответ не требуется.` : orderText(order, config.title);
    const at = stamp();
    // Канал фиксируется в задании: смена канала потом не перенаправляет уже поставленное.
    const transport = TRANSPORTS.has(recipient.transport) ? recipient.transport : 'project_bot';
    return Number(db.prepare(`INSERT INTO site_order_outbox(site,company_code,order_id,kind,chat_id,recipient_version,text,next_attempt_at,created_at,transport,destination)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(site, config.companyCode, order ? order.id : null, kind, recipient.telegram_chat_id, recipient.version, text, at, at, transport, destination).lastInsertRowid);
  }

  /* ---------- публичный приём ---------- */
  const duplicateView = (row) => ({ ok: true, duplicate: true, orderId: row.id, requestId: row.request_id, status: 'accepted',
    message: `Заявка №${row.id} уже принята. Менеджер свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку.` });
  function submit({ site, body, origin, ip }) {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено', 'NOT_FOUND');
    if (!origin || !config.origins.includes(origin)) fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
    const input = validate(body);
    if (input.honeypot) return { status: 200, body: { ok: true, status: 'accepted' } };
    // Повтор проверяется до лимита частоты: повторный клик не должен упираться в 429 и не ищет по контактам.
    const existing = db.prepare('SELECT id,request_id,fingerprint FROM site_orders WHERE site=? AND request_id=?').get(site, input.requestId);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) fail(409, 'Этот номер запроса уже использован для другой заявки', 'REQUEST_MISMATCH');
      return { status: 200, body: duplicateView(existing) };
    }
    const hash = ipHash(ip);
    const at = now();
    db.prepare('DELETE FROM site_order_rate WHERE created_at<?').run(stamp(at - RATE_DAY.windowMs));
    const count = (windowMs) => db.prepare('SELECT count(*) AS n FROM site_order_rate WHERE ip_hash=? AND created_at>=?').get(hash, stamp(at - windowMs)).n;
    if (count(RATE_SHORT.windowMs) >= RATE_SHORT.limit) fail(429, 'Слишком много заявок. Попробуйте через несколько минут', 'RATE_LIMITED');
    if (count(RATE_DAY.windowMs) >= RATE_DAY.limit) fail(429, 'Слишком много заявок за сутки. Попробуйте завтра', 'RATE_LIMITED');
    const index = priceIndex(site);
    if (!index) fail(503, 'Приём заявок временно недоступен. Ваша корзина сохранена', 'ORDERS_UNAVAILABLE');
    let knownTotal = 0, unknownCount = 0;
    const items = input.items.map((item) => {
      const known = index.get(item.id);
      if (!known) { const error = new Error('Состав корзины устарел. Обновите корзину по прайсу'); throw Object.assign(error, { status: 400, code: 'ITEM_UNKNOWN', itemId: item.id }); }
      if (known.price === null) unknownCount += 1;
      else knownTotal += known.price * item.qty;
      return { id: item.id, title: known.title, qty: item.qty, price: known.price };
    });
    if (!Number.isSafeInteger(knownTotal) || knownTotal > MAX_KOPECKS) fail(400, 'Итог заявки слишком велик', 'VALIDATION');
    const recipient = recipientOf(site);
    try {
      const order = tx(() => {
        const id = Number(db.prepare(`INSERT INTO site_orders(site,company_code,request_id,fingerprint,kind,name,phone,phone_normalized,comment,items_json,known_total,unknown_count,page,utm_json,ip_hash,created_at,
          contact_channel,contact,telegram_username,delivery_address,delivery_date,delivery_interval,group_required)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(site, config.companyCode, input.requestId, input.fingerprint, input.kind, input.name, input.phone, input.phoneNormalized,
          input.comment, JSON.stringify(items), knownTotal, unknownCount, input.page, JSON.stringify(input.utm), hash, stamp(at),
          input.contactChannel, input.contact, input.telegramUsername, input.deliveryAddress, input.deliveryDate, input.deliveryInterval, groupEnabled(site) ? 1 : 0).lastInsertRowid);
        db.prepare('INSERT INTO site_order_rate(ip_hash,created_at) VALUES(?,?)').run(hash, stamp(at));
        const row = db.prepare('SELECT * FROM site_orders WHERE id=?').get(id);
        // Получатель не настроен — заявка всё равно сохранена; уведомление владелец отправит явно после настройки.
        if (recipient) enqueue(site, config, 'order', row, recipient);
        const group = groupOf(site);
        if (group) enqueue(site, config, 'order', row, group, 'group');
        return row;
      });
      return { status: 201, body: { ok: true, orderId: order.id, requestId: order.request_id, status: 'accepted',
        message: `Заявка №${order.id} принята. Менеджер свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку.` } };
    } catch (error) {
      // Одновременный повтор того же requestId: вторая вставка упирается в UNIQUE — отвечаем как на повтор.
      if (/UNIQUE/.test(String(error.message))) {
        const row = db.prepare('SELECT id,request_id,fingerprint FROM site_orders WHERE site=? AND request_id=?').get(site, input.requestId);
        if (row && row.fingerprint === input.fingerprint) return { status: 200, body: duplicateView(row) };
        if (row) fail(409, 'Этот номер запроса уже использован для другой заявки', 'REQUEST_MISMATCH');
      }
      throw error;
    }
  }

  /* ---------- очередь для моста ---------- */
  const jobJSON = (job) => ({ id: `${JOB_PREFIX}${job.id}`, companyCode: job.company_code, chatId: job.chat_id, messageId: null,
    attempt: job.attempts, text: job.text, authorName: 'Заявка с сайта', authorType: 'system', attachments: [],
    // Клиентскому боту нужны номер заявки и вид задания (кнопки статуса только у заявки, не у проверки).
    ...(job.transport === 'client_bot' ? { site: job.site, orderId: job.order_id, orderKind: job.kind } : {}) });
  /* Мост каждого канала забирает только свои задания. Общий чат проекта вызывает без аргумента — прежний канал.
     Вызывается внутри транзакции вызывающего модуля. */
  function pendingTelegram(transport = 'project_bot', site = null) {
    if (!TRANSPORTS.has(transport)) fail(400, 'Неизвестный канал уведомлений');
    if (site !== null && !siteConfig(site)) fail(404, 'Не найдено');
    // Ограничение компании применяется до захвата: чужое задание не меняет состояние и попытки.
    const expired = db.prepare(`SELECT id,order_id,kind FROM site_order_outbox WHERE status='sending' AND claimed_at<? AND transport=? AND (? IS NULL OR site=?)`).all(stamp(now() - TELEGRAM_LEASE), transport, site, site);
    for (const job of expired) settle(job.id, 'uncertain', 'Отправка прервана; результат доставки неизвестен', []);
    // Проверяем действующую привязку до захвата. Начатое/неизвестно доставленное не перенаправляем.
    const groupJobs = db.prepare(`SELECT id,site,chat_id,external_ids FROM site_order_outbox WHERE destination='group' AND status='pending' AND transport=? AND (? IS NULL OR site=?)`).all(transport, site, site);
    for (const job of groupJobs) if (groupOf(job.site)?.telegram_chat_id !== job.chat_id) settle(job.id, 'error', 'Рабочая группа изменилась или отключена до отправки', JSON.parse(job.external_ids || '[]'));
    const jobs = db.prepare(`SELECT * FROM site_order_outbox WHERE status='pending' AND next_attempt_at<=? AND transport=? AND (? IS NULL OR site=?) ORDER BY id LIMIT 1`).all(stamp(), transport, site, site);
    for (const job of jobs) db.prepare(`UPDATE site_order_outbox SET status='sending',claimed_at=?,attempts=attempts+1 WHERE id=?`).run(stamp(), job.id);
    return jobs.map((job) => jobJSON({ ...job, attempts: job.attempts + 1 }));
  }
  /* Сведения о задании для клиентского бота: какой заявке и какому чату оно отправлялось. */
  function orderJob(jobId) {
    const id = Number(String(jobId).slice(JOB_PREFIX.length));
    if (!isOrderJob(jobId) || !Number.isSafeInteger(id) || id < 1) return null;
    const job = db.prepare('SELECT id,site,order_id,kind,chat_id,transport,status FROM site_order_outbox WHERE id=?').get(id);
    return job ? { id: job.id, site: job.site, orderId: job.order_id, kind: job.kind, chatId: job.chat_id, transport: job.transport, status: job.status } : null;
  }
  const isOrderJob = (jobId) => typeof jobId === 'string' && jobId.startsWith(JOB_PREFIX);
  const currentAttempt = (orderId) => db.prepare("SELECT id FROM site_order_outbox WHERE order_id=? AND kind='order' AND destination='manager' ORDER BY id DESC LIMIT 1").get(orderId)?.id;
  function settle(jobId, status, error, ids) {
    const job = db.prepare('SELECT * FROM site_order_outbox WHERE id=?').get(jobId);
    const finished = ['sent', 'uncertain', 'error'].includes(status) ? stamp() : null;
    db.prepare(`UPDATE site_order_outbox SET status=?,error=?,external_ids=?,next_attempt_at=?,claimed_at=NULL,finished_at=COALESCE(?,finished_at) WHERE id=?`)
      .run(status, error, JSON.stringify(ids), stamp(now() + 15000 * Math.max(1, job.attempts)), finished, job.id);
    // Статус заявки отражает только текущую (последнюю) попытку: поздний ответ по прежней её не перезаписывает.
    if (job.destination === 'manager' && job.kind === 'order' && job.order_id && currentAttempt(job.order_id) === job.id) {
      const orderStatus = status === 'sent' ? 'notified' : status === 'uncertain' ? 'notify_uncertain' : status === 'error' ? 'notify_failed' : null;
      if (orderStatus) db.prepare('UPDATE site_orders SET status=?,notified_at=COALESCE(?,notified_at) WHERE id=?').run(orderStatus, status === 'sent' ? stamp() : null, job.order_id);
    }
    if (job.kind === 'test' && finished) {
      // Подтверждение засчитывается только текущему получателю: тест прежнего получателя ничего не доказывает.
      const recipient = recipientOf(job.site);
      if (recipient && recipient.version === job.recipient_version && recipient.telegram_chat_id === job.chat_id) {
        db.prepare('UPDATE site_order_recipients SET verified_at=?,last_test_error=?,updated_at=? WHERE site=?')
          .run(status === 'sent' ? stamp() : recipient.verified_at, status === 'sent' ? '' : shortText(error, 200), stamp(), job.site);
      }
    }
  }
  function acknowledge(jobId, result = {}) {
    const id = Number(String(jobId).slice(JOB_PREFIX.length));
    if (!Number.isSafeInteger(id) || id < 1) fail(404, 'Отправка не найдена');
    return tx(() => {
      const job = db.prepare('SELECT * FROM site_order_outbox WHERE id=?').get(id);
      if (!job) fail(404, 'Отправка не найдена');
      if (job.status === 'sent') return { ok: true, status: 'sent' };
      const known = JSON.parse(job.external_ids || '[]');
      const ids = [...new Set([...known, ...(Array.isArray(result.externalMessageIds) ? result.externalMessageIds.map(String) : [])])];
      // Завершённое задание (uncertain/error) поздний ответ не оживляет: только подтверждённый успех уточняет исход.
      if (['uncertain', 'error'].includes(job.status)) {
        if (result.ok) settle(job.id, 'sent', '', ids);
        else if (ids.length !== known.length) db.prepare('UPDATE site_order_outbox SET external_ids=? WHERE id=?').run(JSON.stringify(ids), job.id);
        return { ok: Boolean(result.ok), status: result.ok ? 'sent' : job.status };
      }
      // Неизвестный результат сети никогда не повторяем автоматически: части уже могли уйти.
      const status = result.ok ? 'sent'
        : result.uncertain ? 'uncertain'
          : result.retryable && job.attempts < TELEGRAM_ATTEMPTS ? 'pending' : 'error';
      const error = result.ok ? '' : shortText(result.error || 'Не удалось отправить в Telegram', 300);
      settle(job.id, status, error, ids);
      return { ok: Boolean(result.ok), status };
    });
  }

  /* ---------- владелец ---------- */
  const notifyJSON = (job) => (job ? { jobId: `${JOB_PREFIX}${job.id}`, kind: job.kind, status: job.status, attempts: job.attempts, error: job.error,
    createdAt: job.created_at, finishedAt: job.finished_at, recipientVersion: job.recipient_version } : null);
  const workJSON = (orderId) => {
    const row = db.prepare('SELECT status,updated_by,updated_at FROM site_order_work WHERE order_id=?').get(orderId);
    return row ? { status: row.status, updatedBy: row.updated_by, updatedAt: row.updated_at } : { status: 'new', updatedBy: '', updatedAt: null };
  };
  const checklistActor = (row) => row ? { type: row.actor_type, id: row.actor_id, label: row.actor_label } : null;
  function checklistJSON(site, orderId, history = true) {
    if (!checklistEnabled(site)) return null;
    const rows = db.prepare('SELECT * FROM site_order_checklist WHERE order_id=?').all(orderId);
    const items = Object.entries(CHECKLIST_ITEMS).map(([key, label]) => {
      const row = rows.find((item) => item.item === key);
      return { key, label, checked: Boolean(row?.checked), revision: row?.revision || 0, actor: checklistActor(row), updatedAt: row?.updated_at || null };
    });
    return { items, ...(history ? { history: db.prepare('SELECT * FROM site_order_checklist_events WHERE order_id=? ORDER BY id DESC LIMIT 20').all(orderId)
      .map((row) => ({ id: row.id, key: row.item, checked: Boolean(row.checked), revision: row.revision, actor: checklistActor(row), createdAt: row.created_at })) } : {}) };
  }
  const groupNotifyJSON = (row) => {
    if (!row.group_required) return null;
    const job = db.prepare("SELECT * FROM site_order_outbox WHERE order_id=? AND kind='order' AND destination='group' ORDER BY id DESC LIMIT 1").get(row.id);
    const configured = Boolean(groupOf(row.site));
    return { required: true, configured, ...notifyJSON(job), status: job?.status || (configured ? 'not_queued' : 'missing_binding') };
  };
  const orderJSON = (row) => ({ id: row.id, requestId: row.request_id, kind: row.kind, status: row.status, createdAt: row.created_at, notifiedAt: row.notified_at,
    work: workJSON(row.id),
    name: row.name, phone: row.phone, comment: row.comment, items: JSON.parse(row.items_json), knownTotal: row.known_total, unknownCount: row.unknown_count,
    contactChannel: row.contact_channel, contact: row.contact, telegramUsername: row.telegram_username,
    deliveryAddress: row.delivery_address, deliveryDate: row.delivery_date, deliveryInterval: row.delivery_interval,
    page: row.page, utm: JSON.parse(row.utm_json || '{}'),
    groupNotify: groupNotifyJSON(row),
    ...(checklistEnabled(row.site) ? { checklist: checklistJSON(row.site, row.id) } : {}),
    notify: notifyJSON(db.prepare("SELECT * FROM site_order_outbox WHERE order_id=? AND kind='order' AND destination='manager' ORDER BY id DESC LIMIT 1").get(row.id)) });
  function recipientStatus(site) {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено');
    const recipient = recipientOf(site);
    // Заявки без уведомления, которое ушло или идёт: принятые без задания и с остановленным/отказанным заданием.
    // Неизвестно доставленные сюда не входят — их повтор владелец решает отдельно.
    const unnotified = db.prepare(`SELECT count(*) AS n FROM site_orders o WHERE o.site=? AND o.status IN ('accepted','notify_failed')
      AND NOT EXISTS (SELECT 1 FROM site_order_outbox x WHERE x.order_id=o.id AND x.kind='order' AND x.destination='manager' AND x.status IN ('pending','sending','sent'))`).get(site).n;
    const lastTest = db.prepare("SELECT * FROM site_order_outbox WHERE site=? AND kind='test' ORDER BY id DESC LIMIT 1").get(site);
    return { configured: Boolean(recipient), telegramChatId: recipient?.telegram_chat_id || '', label: recipient?.label || '',
      version: recipient?.version || 0, verifiedAt: recipient?.verified_at || null, lastTestError: recipient?.last_test_error || '',
      transport: recipient?.transport || 'project_bot',
      group: { enabled: groupEnabled(site), configured: Boolean(groupOf(site)) },
      lastTest: notifyJSON(lastTest && recipient && lastTest.recipient_version === recipient.version ? lastTest : null),
      unnotifiedOrders: unnotified, updatedAt: recipient?.updated_at || null };
  }
  /* Список новыми вперёд, страницами по id: beforeId — курсор с прошлой страницы, nextCursor — null, когда всё показано. */
  function listOrders(site, { limit, beforeId } = {}) {
    if (!siteConfig(site)) fail(404, 'Не найдено');
    const size = limit === undefined || limit === null || limit === '' ? 50 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > LIST_LIMIT) fail(400, `Параметр limit — целое от 1 до ${LIST_LIMIT}`);
    const cursor = beforeId === undefined || beforeId === null || beforeId === '' ? null : Number(beforeId);
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) fail(400, 'Некорректный курсор beforeId');
    const rows = cursor === null
      ? db.prepare('SELECT * FROM site_orders WHERE site=? ORDER BY id DESC LIMIT ?').all(site, size + 1)
      : db.prepare('SELECT * FROM site_orders WHERE site=? AND id<? ORDER BY id DESC LIMIT ?').all(site, cursor, size + 1);
    const page = rows.slice(0, size);
    return { orders: page.map(orderJSON), nextCursor: rows.length > size ? page[page.length - 1].id : null, recipient: recipientStatus(site) };
  }
  /* Смена получателя сбрасывает подтверждение и меняет версию: старые тесты и задания ей не засчитываются. */
  function setRecipient(site, body) {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено');
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => !['telegramChatId', 'label'].includes(k))) fail(400, 'Неизвестное поле');
    const chatId = cleanString(body.telegramChatId, 20, 'telegramChatId');
    if (!CHAT_ID.test(chatId)) fail(400, 'Укажите числовой Telegram ID личного чата получателя');
    const label = cleanString(body.label, 80, 'label');
    tx(() => {
      const current = recipientOf(site);
      const at = stamp();
      if (!current) db.prepare('INSERT INTO site_order_recipients(site,company_code,telegram_chat_id,label,updated_at) VALUES(?,?,?,?,?)').run(site, config.companyCode, chatId, label, at);
      else if (current.telegram_chat_id !== chatId) {
        // Новый получатель возвращается на прежний канал: клиентский бот привязан к конкретному Telegram ID оператора.
        db.prepare(`UPDATE site_order_recipients SET telegram_chat_id=?,label=?,version=version+1,verified_at=NULL,last_test_error='',transport='project_bot',updated_at=? WHERE site=?`).run(chatId, label, at, site);
        // Ещё не начатые задания прежнему получателю останавливаются: новому их отправит только явный повтор владельца.
        // Уже отправляемые и неизвестно доставленные не перенаправляются.
        const stopped = db.prepare(`SELECT id FROM site_order_outbox WHERE site=? AND status='pending' AND destination='manager'`).all(site);
        for (const job of stopped) settle(job.id, 'error', 'Получатель изменён до отправки', JSON.parse(db.prepare('SELECT external_ids FROM site_order_outbox WHERE id=?').get(job.id).external_ids || '[]'));
      } else db.prepare('UPDATE site_order_recipients SET label=?,updated_at=? WHERE site=?').run(label, at, site);
    });
    return recipientStatus(site);
  }
  function testRecipient(site) {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено');
    const recipient = recipientOf(site);
    if (!recipient) fail(409, 'Получатель заявок не настроен');
    const jobId = tx(() => enqueue(site, config, 'test', null, recipient));
    return { ok: true, jobId: `${JOB_PREFIX}${jobId}`, recipient: recipientStatus(site) };
  }
  /* Явный повтор владельцем: новое задание текущему получателю; прежнее состояние (uncertain/error) сохраняется в истории. */
  function renotify(site, orderId, destination = 'manager') {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено');
    const id = Number(orderId);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный номер заявки');
    const order = db.prepare('SELECT * FROM site_orders WHERE id=? AND site=?').get(id, site);
    if (!order) fail(404, 'Заявка не найдена');
    if (!['manager', 'group'].includes(destination)) fail(400, 'Неизвестное назначение');
    if (destination === 'group' && !order.group_required) fail(409, 'Групповое уведомление для этой заявки не включено');
    const recipient = destination === 'group' ? groupOf(site) : recipientOf(site);
    if (!recipient) fail(409, destination === 'group' ? 'Рабочая группа не настроена' : 'Получатель заявок не настроен');
    let previous;
    const jobId = tx(() => {
      const active = db.prepare("SELECT id FROM site_order_outbox WHERE order_id=? AND destination=? AND status IN ('pending','sending') LIMIT 1").get(id, destination);
      if (active) fail(409, 'Уведомление по этой заявке уже отправляется');
      previous = db.prepare("SELECT * FROM site_order_outbox WHERE order_id=? AND kind='order' AND destination=? ORDER BY id DESC LIMIT 1").get(id, destination);
      return enqueue(site, config, 'order', order, recipient, destination);
    });
    return { ok: true, jobId: `${JOB_PREFIX}${jobId}`, previous: notifyJSON(previous), order: orderJSON(db.prepare('SELECT * FROM site_orders WHERE id=?').get(id)) };
  }

  /* Смена канала уведомлений. Клиентский бот — только если модуль клиентского бота подтвердил готовность
     (включён, оператор привязан к Telegram ID этого получателя). Смена ничего не рассылает: прежние заявки
     остаются с прежним исходом, ещё не начатые задания останавливаются так же, как при смене получателя. */
  function setTransport(site, body, { clientBotReady = () => ({ ok: false, reason: 'Клиентский бот не подключён' }) } = {}) {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено');
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'transport')) fail(400, 'Неизвестное поле');
    const transport = body.transport;
    if (!TRANSPORTS.has(transport)) fail(400, 'Неизвестный канал уведомлений');
    const recipient = recipientOf(site);
    if (!recipient) fail(409, 'Получатель заявок не настроен');
    if (recipient.transport === transport) return recipientStatus(site);
    if (transport === 'client_bot') {
      const ready = clientBotReady(site, recipient.telegram_chat_id) || {};
      if (!ready.ok) fail(409, ready.reason || 'Клиентский бот не готов');
    }
    tx(() => {
      db.prepare(`UPDATE site_order_recipients SET transport=?,version=version+1,verified_at=NULL,last_test_error='',updated_at=? WHERE site=?`).run(transport, stamp(), site);
      const stopped = db.prepare(`SELECT id,external_ids FROM site_order_outbox WHERE site=? AND status='pending' AND destination='manager'`).all(site);
      for (const job of stopped) settle(job.id, 'error', 'Канал уведомлений изменён до отправки', JSON.parse(job.external_ids || '[]'));
    });
    return recipientStatus(site);
  }
  /* Статус обработки меняет менеджер (кнопкой в Telegram) или владелец. Повтор того же статуса — без изменений. */
  function setWorkStatus(site, orderId, status, actor = '') {
    if (!siteConfig(site)) fail(404, 'Не найдено');
    if (!WORK_STATUSES.has(status)) fail(400, 'Неизвестный статус обработки');
    const id = Number(orderId);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный номер заявки');
    const order = db.prepare('SELECT id FROM site_orders WHERE id=? AND site=?').get(id, site);
    if (!order) fail(404, 'Заявка не найдена');
    const before = workJSON(id);
    if (before.status === status) return { changed: false, work: before };
    const at = stamp(), who = shortText(actor, 80);
    tx(() => {
      db.prepare(`INSERT INTO site_order_work(order_id,status,updated_by,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(id, status, who, at);
      db.prepare('INSERT INTO site_order_work_events(order_id,status,actor,created_at) VALUES(?,?,?,?)').run(id, status, who, at);
    });
    return { changed: true, work: workJSON(id) };
  }
  /* Ручное подтверждение менеджера, не событие доставки. Не создаёт outbox и не меняет обработку. */
  function checklistOrder(site, orderId) {
    if (!checklistEnabled(site)) fail(404, 'Чек-лист недоступен');
    const id = Number(orderId);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный номер заявки');
    const row = db.prepare('SELECT * FROM site_orders WHERE id=? AND site=?').get(id, site);
    if (!row) fail(404, 'Заявка не найдена');
    return { order: orderJSON(row) };
  }
  function setChecklist(site, orderId, body, actor) {
    if (!checklistEnabled(site)) fail(404, 'Чек-лист недоступен');
    const id = Number(orderId);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный номер заявки');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['item', 'checked', 'revision'].includes(key))
      || !Object.hasOwn(CHECKLIST_ITEMS, body.item) || typeof body.checked !== 'boolean' || !Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'Некорректная отметка');
    if (!actor || !['owner', 'telegram'].includes(actor.type) || !/^\d{1,20}$/.test(String(actor.id))) fail(400, 'Не указан автор отметки');
    const who = { type: actor.type, id: String(actor.id), label: shortText(actor.label || (actor.type === 'owner' ? 'Владелец' : 'Менеджер в Telegram'), 80) };
    return tx(() => {
      const order = db.prepare('SELECT * FROM site_orders WHERE id=? AND site=?').get(id, site);
      if (!order) fail(404, 'Заявка не найдена');
      const before = checklistJSON(site, id, false).items.find((item) => item.key === body.item);
      if (body.revision !== before.revision) {
        const replay = body.revision === before.revision - 1 && before.checked === body.checked && before.actor?.type === who.type && before.actor?.id === who.id;
        if (!replay) fail(409, 'Отметка уже изменена. Обновите заявку', 'CHECKLIST_STALE');
        return { changed: false, order: orderJSON(order) };
      }
      if (before.checked === body.checked) return { changed: false, order: orderJSON(order) };
      const at = stamp(), revision = before.revision + 1, checked = body.checked ? 1 : 0;
      db.prepare(`INSERT INTO site_order_checklist(order_id,item,checked,revision,actor_type,actor_id,actor_label,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(order_id,item) DO UPDATE SET checked=excluded.checked,revision=excluded.revision,actor_type=excluded.actor_type,actor_id=excluded.actor_id,actor_label=excluded.actor_label,updated_at=excluded.updated_at`)
        .run(id, body.item, checked, revision, who.type, who.id, who.label, at);
      db.prepare('INSERT INTO site_order_checklist_events(order_id,item,checked,revision,actor_type,actor_id,actor_label,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, body.item, checked, revision, who.type, who.id, who.label, at);
      return { changed: true, order: orderJSON(order) };
    });
  }
  /* Короткая сводка заявки для клиентского бота: без контактов, только то, что нужно для связи с диалогом. */
  function orderSummary(site, orderId) {
    const id = Number(orderId);
    if (!siteConfig(site) || !Number.isSafeInteger(id) || id < 1) return null;
    const row = db.prepare('SELECT id,request_id,created_at FROM site_orders WHERE id=? AND site=?').get(id, site);
    return row ? { id: row.id, requestId: row.request_id, createdAt: row.created_at, work: workJSON(row.id),
      ...(checklistEnabled(site) ? { checklist: checklistJSON(site, row.id, false) } : {}) } : null;
  }

  return { submit, pendingTelegram, acknowledge, isOrderJob, orderJob, listOrders, recipientStatus, setRecipient, setTransport, testRecipient, renotify,
    setWorkStatus, setChecklist, checklistOrder, orderSummary, sites: Object.keys(sites) };
}

/* Точный allowlist Origin для заявок Palitra: боевой домен без www (www отвечает 301 и страниц не отдаёт)
   и временный адрес, который работает до и после переключения DNS. Шаблонов и поддоменов нет. */
const PALITRA_ORDER_ORIGINS = Object.freeze(['https://palitra-love.ru', 'https://palitra-love.synapsebusiness.ru']);
module.exports = { createSiteOrders, clientIp, originOf, priceKopecks, isPrivateAddress, ORDER_STATUSES, JOB_PREFIX, PALITRA_ORDER_ORIGINS,
  TRANSPORTS, WORK_STATUSES };
