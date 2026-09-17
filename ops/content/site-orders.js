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
const BODY_FIELDS = new Set(['requestId', 'kind', 'name', 'phone', 'comment', 'consent', 'items', 'occasion', 'date', 'page', 'utm', 'website']);
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const RATE_SHORT = { windowMs: 10 * 60 * 1000, limit: 5 };
const RATE_DAY = { windowMs: 24 * 60 * 60 * 1000, limit: 20 };
const TELEGRAM_ATTEMPTS = 3;
const TELEGRAM_LEASE = 10 * 60 * 1000;
const MAX_KOPECKS = 10 ** 13;            // защита от переполнения итога: выше — цена неизвестна
const PRICE_PATTERN = /^\s*(\d[\d\s ]*)(?:[.,](\d{1,2}))?\s*(?:руб\.?|р\.?|₽)?\s*$/i;
const JOB_PREFIX = 'order:';
const LIST_LIMIT = 100;

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

function createSiteOrders({ db, tx, sites = {}, priceReader, ipSalt = '', now = Date.now }) {
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
  `);
  const stamp = (at = now()) => new Date(at).toISOString();
  const siteConfig = (site) => (Object.hasOwn(sites, site) ? sites[site] : null);
  const ipHash = (ip) => sha256(`${ip}|${ipSalt}`);

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
    const phone = cleanString(body.phone, 32, 'phone');
    let digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
    if (digits.length < 10 || digits.length > 15) fail(400, 'Укажите телефон', 'VALIDATION');
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
    const fingerprint = sha256(JSON.stringify({ kind: body.kind, name, phone: digits, comment, items }));
    return { requestId, kind: body.kind, name, phone, phoneNormalized: digits, comment, items, page, utm, honeypot: Boolean(website), fingerprint };
  }

  /* ---------- текст уведомления ---------- */
  const moscow = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function orderText(order, siteTitle) {
    const lines = [`Заявка №${order.id} · ${siteTitle} · ${moscow(order.created_at)}`, `Имя: ${order.name}`, `Телефон: ${order.phone}`];
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
  function enqueue(site, config, kind, order, recipient) {
    const text = kind === 'test' ? `Проверка получателя заявок ${config.title}. Ответ не требуется.` : orderText(order, config.title);
    const at = stamp();
    return Number(db.prepare(`INSERT INTO site_order_outbox(site,company_code,order_id,kind,chat_id,recipient_version,text,next_attempt_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(site, config.companyCode, order ? order.id : null, kind, recipient.telegram_chat_id, recipient.version, text, at, at).lastInsertRowid);
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
        const id = Number(db.prepare(`INSERT INTO site_orders(site,company_code,request_id,fingerprint,kind,name,phone,phone_normalized,comment,items_json,known_total,unknown_count,page,utm_json,ip_hash,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(site, config.companyCode, input.requestId, input.fingerprint, input.kind, input.name, input.phone, input.phoneNormalized,
          input.comment, JSON.stringify(items), knownTotal, unknownCount, input.page, JSON.stringify(input.utm), hash, stamp(at)).lastInsertRowid);
        db.prepare('INSERT INTO site_order_rate(ip_hash,created_at) VALUES(?,?)').run(hash, stamp(at));
        const row = db.prepare('SELECT * FROM site_orders WHERE id=?').get(id);
        // Получатель не настроен — заявка всё равно сохранена; уведомление владелец отправит явно после настройки.
        if (recipient) enqueue(site, config, 'order', row, recipient);
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
    attempt: job.attempts, text: job.text, authorName: 'Заявка с сайта', authorType: 'system', attachments: [] });
  function pendingTelegram() {
    // Вызывается внутри транзакции pendingTelegram общего чата.
    const expired = db.prepare(`SELECT id,order_id,kind FROM site_order_outbox WHERE status='sending' AND claimed_at<?`).all(stamp(now() - TELEGRAM_LEASE));
    for (const job of expired) settle(job.id, 'uncertain', 'Отправка прервана; результат доставки неизвестен', []);
    const jobs = db.prepare(`SELECT * FROM site_order_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1`).all(stamp());
    for (const job of jobs) db.prepare(`UPDATE site_order_outbox SET status='sending',claimed_at=?,attempts=attempts+1 WHERE id=?`).run(stamp(), job.id);
    return jobs.map((job) => jobJSON({ ...job, attempts: job.attempts + 1 }));
  }
  const isOrderJob = (jobId) => typeof jobId === 'string' && jobId.startsWith(JOB_PREFIX);
  const currentAttempt = (orderId) => db.prepare("SELECT id FROM site_order_outbox WHERE order_id=? AND kind='order' ORDER BY id DESC LIMIT 1").get(orderId)?.id;
  function settle(jobId, status, error, ids) {
    const job = db.prepare('SELECT * FROM site_order_outbox WHERE id=?').get(jobId);
    const finished = ['sent', 'uncertain', 'error'].includes(status) ? stamp() : null;
    db.prepare(`UPDATE site_order_outbox SET status=?,error=?,external_ids=?,next_attempt_at=?,claimed_at=NULL,finished_at=COALESCE(?,finished_at) WHERE id=?`)
      .run(status, error, JSON.stringify(ids), stamp(now() + 15000 * Math.max(1, job.attempts)), finished, job.id);
    // Статус заявки отражает только текущую (последнюю) попытку: поздний ответ по прежней её не перезаписывает.
    if (job.kind === 'order' && job.order_id && currentAttempt(job.order_id) === job.id) {
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
  const orderJSON = (row) => ({ id: row.id, requestId: row.request_id, kind: row.kind, status: row.status, createdAt: row.created_at, notifiedAt: row.notified_at,
    name: row.name, phone: row.phone, comment: row.comment, items: JSON.parse(row.items_json), knownTotal: row.known_total, unknownCount: row.unknown_count,
    page: row.page, utm: JSON.parse(row.utm_json || '{}'),
    notify: notifyJSON(db.prepare("SELECT * FROM site_order_outbox WHERE order_id=? AND kind='order' ORDER BY id DESC LIMIT 1").get(row.id)) });
  function recipientStatus(site) {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено');
    const recipient = recipientOf(site);
    // Заявки без уведомления, которое ушло или идёт: принятые без задания и с остановленным/отказанным заданием.
    // Неизвестно доставленные сюда не входят — их повтор владелец решает отдельно.
    const unnotified = db.prepare(`SELECT count(*) AS n FROM site_orders o WHERE o.site=? AND o.status IN ('accepted','notify_failed')
      AND NOT EXISTS (SELECT 1 FROM site_order_outbox x WHERE x.order_id=o.id AND x.kind='order' AND x.status IN ('pending','sending','sent'))`).get(site).n;
    const lastTest = db.prepare("SELECT * FROM site_order_outbox WHERE site=? AND kind='test' ORDER BY id DESC LIMIT 1").get(site);
    return { configured: Boolean(recipient), telegramChatId: recipient?.telegram_chat_id || '', label: recipient?.label || '',
      version: recipient?.version || 0, verifiedAt: recipient?.verified_at || null, lastTestError: recipient?.last_test_error || '',
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
        db.prepare(`UPDATE site_order_recipients SET telegram_chat_id=?,label=?,version=version+1,verified_at=NULL,last_test_error='',updated_at=? WHERE site=?`).run(chatId, label, at, site);
        // Ещё не начатые задания прежнему получателю останавливаются: новому их отправит только явный повтор владельца.
        // Уже отправляемые и неизвестно доставленные не перенаправляются.
        const stopped = db.prepare(`SELECT id FROM site_order_outbox WHERE site=? AND status='pending'`).all(site);
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
  function renotify(site, orderId) {
    const config = siteConfig(site);
    if (!config) fail(404, 'Не найдено');
    const id = Number(orderId);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный номер заявки');
    const order = db.prepare('SELECT * FROM site_orders WHERE id=? AND site=?').get(id, site);
    if (!order) fail(404, 'Заявка не найдена');
    const recipient = recipientOf(site);
    if (!recipient) fail(409, 'Получатель заявок не настроен');
    const active = db.prepare("SELECT id FROM site_order_outbox WHERE order_id=? AND status IN ('pending','sending') LIMIT 1").get(id);
    if (active) fail(409, 'Уведомление по этой заявке уже отправляется');
    const previous = db.prepare("SELECT * FROM site_order_outbox WHERE order_id=? AND kind='order' ORDER BY id DESC LIMIT 1").get(id);
    const jobId = tx(() => enqueue(site, config, 'order', order, recipient));
    return { ok: true, jobId: `${JOB_PREFIX}${jobId}`, previous: notifyJSON(previous), order: orderJSON(db.prepare('SELECT * FROM site_orders WHERE id=?').get(id)) };
  }

  return { submit, pendingTelegram, acknowledge, isOrderJob, listOrders, recipientStatus, setRecipient, testRecipient, renotify, sites: Object.keys(sites) };
}

module.exports = { createSiteOrders, clientIp, originOf, priceKopecks, isPrivateAddress, ORDER_STATUSES, JOB_PREFIX };
