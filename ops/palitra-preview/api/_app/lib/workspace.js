'use strict';
/*
 * Palitra CRM — обращения, клиенты и заказы компании palitra-love.
 *
 * Обращение (inquiry) — первичная запись: заявка с сайта, ручная запись сотрудника о сообщении в
 * Instagram/Telegram или звонке, обращение из подключённого входящего канала. Заказ (order) создаётся
 * из обращения один раз и хранится в собственной таблице CRM: прежняя site_orders не дополняется
 * «новыми заявками» при преобразовании, а публичный заказ сайта связан с ней по site_order_id.
 *
 * Все изменения: серверная проверка роли и компании, requestId (повтор того же тела не выполняется
 * второй раз), версия карточки (устаревшая кнопка не двигает изменённый заказ), одна транзакция с
 * историей и заданием уведомления. Клиенту не выдаются служебные заметки, ответственный, следующий
 * шаг, срок и чужие контакты.
 */
const { createHash } = require('node:crypto');
// Модуль заказов сайта НЕ импортируется здесь: рабочий хост передаёт свой siteOrders явно, а историческая
// копия vendor/site-orders.js подключается лениво только для локальной демонстрации и тестов.

/* Цена прайса — «9 270 руб.»; всё, что не ровно число («от 5 000», «договорная»), — неизвестная цена.
   Та же схема, что у модуля заказов сайта, чтобы итог обращения совпадал с итогом корзины. */
const PRICE_PATTERN = /^\s*(\d[\d\s ]*)(?:[.,](\d{1,2}))?\s*(?:руб\.?|р\.?|₽)?\s*$/i;
const MAX_KOPECKS = 10 ** 13;
function priceKopecks(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= MAX_KOPECKS / 100 ? Math.round(value * 100) : null;
  const match = PRICE_PATTERN.exec(String(value ?? ''));
  if (!match) return null;
  const rubles = Number(match[1].replace(/[\s ]/g, ''));
  const kopecks = Number((match[2] || '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(rubles) || rubles < 0 || rubles * 100 + kopecks > MAX_KOPECKS) return null;
  return rubles * 100 + kopecks;
}

const SITE = 'palitra';
const COMPANY = 'palitra-love';
const TZ_OFFSET_MIN = 180; // Europe/Moscow, без перехода на летнее время
const STAGES = ['new', 'agreeing', 'awaiting_payment', 'preparing', 'photo', 'delivering', 'done'];
const LABELS = { new: 'Новый заказ', agreeing: 'Согласование', awaiting_payment: 'Ожидаем оплату', preparing: 'Готовим заказ',
  photo: 'Фото на согласовании', delivering: 'Доставка / выдача', done: 'Заказ выполнен' };
const STAGE_EVENTS = { agreeing: 'Начато согласование', awaiting_payment: 'Состав согласован, ждём оплату', preparing: 'Заказ готовится',
  photo: 'Фото показано клиенту', delivering: 'Заказ передан в доставку', done: 'Заказ выполнен' };
const SOURCES = ['site', 'telegram', 'instagram', 'call'];
const MANUAL_SOURCES = ['instagram', 'telegram', 'call'];
const SOURCE_LABELS = { site: 'Сайт', telegram: 'Telegram', instagram: 'Instagram', call: 'Звонок' };
// Каналы связи, которые сотрудник может указать вручную. Внутренние идентификаторы каналов (tgid/igsid) — только из подключённых входов.
const MANUAL_CHANNELS = { instagram: ['instagram', 'phone'], telegram: ['telegram', 'phone'], call: ['phone', 'whatsapp'] };
const CHANNEL_LABELS = { phone: 'Телефон', whatsapp: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram', max: 'MAX',
  telegram_id: 'Telegram', instagram_id: 'Instagram' };
const BASIS = { incoming_message: 'Клиент написал сам', incoming_call: 'Клиент позвонил сам',
  repeat_customer: 'Повторное обращение клиента', site_request: 'Клиент оставил заявку на сайте',
  app_request: 'Клиент оформил заказ в приложении', channel_message: 'Входящее сообщение в подключённом канале' };
const MANUAL_BASIS = ['incoming_message', 'incoming_call', 'repeat_customer'];
const MARKETING = ['unknown', 'granted', 'declined'];
const FULFILLMENT = ['delivery', 'pickup', 'courier'];
const FULFILLMENT_LABELS = { delivery: 'Доставка', pickup: 'Самовывоз', courier: 'Курьер клиента' };
const PICKUP_POINT = 'г. Подольск, ул. Генерала Стрельбицкого, 3, 2 этаж';
const INTERVALS = ['10:00–12:00', '12:00–14:00', '14:00–16:00', '16:00–18:00', '18:00–20:00', '20:00–22:00',
  'Ночной 23:00–10:00 — согласовать', 'Другое время — согласовать'];
// Самовывоз и курьер клиента — в рабочее время 09:00–21:00 (как на сайте): 20–22 и ночь не предлагаются.
const INTERVALS_FOR = { delivery: INTERVALS, pickup: INTERVALS.filter((v) => !/^20:00|^Ночной/.test(v)),
  courier: INTERVALS.filter((v) => !/^20:00|^Ночной/.test(v)) };
const ITEMS_STAGES = ['new', 'agreeing', 'awaiting_payment'];
const DETAILS_STAGES = ['new', 'agreeing', 'awaiting_payment', 'preparing', 'photo'];
const GUIDE = 'Берегите шары от прямого солнца, нагревателей и острых предметов. Переносите аккуратно, не оставляйте в нагретой машине. '
  + 'Латексные шары радуют дольше в прохладном помещении. Текст памятки предварительный — Дарья согласует его перед запуском.';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

// Демонстрационные участники. Только для локального просмотра (server.cjs); защищённый HTTP их не принимает.
const ACTORS = Object.freeze({
  varvara: Object.freeze({ id: 'demo-varvara', name: 'Варвара', role: 'admin', companyCode: COMPANY }),
  darya: Object.freeze({ id: 'demo-darya', name: 'Дарья', role: 'owner', companyCode: COMPANY }),
  vlad: Object.freeze({ id: 'demo-vlad', name: 'Влад', role: 'owner', companyCode: COMPANY }),
  customer: Object.freeze({ id: 'demo-customer', name: 'Анна · пример', role: 'customer', companyCode: COMPANY,
    principal: Object.freeze({ provider: 'demo', subject: 'customer' }) })
});
const DEMO_STAFF = () => Object.values(ACTORS).filter((a) => a.role !== 'customer').map(({ id, name, role }) => ({ id, name, role }));

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
function fail(status, message, code) { throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); }
function scoped(actor) { if (!actor || typeof actor !== 'object' || actor.companyCode !== COMPANY) fail(403, 'Доступ закрыт'); }
function staff(actor) { scoped(actor); if (!['owner', 'admin'].includes(actor.role)) fail(403, 'Действие доступно сотруднику Palitra'); }
function owner(actor) { scoped(actor); if (actor.role !== 'owner') fail(403, 'Настройка доступна собственнику'); }
const isStaff = (actor) => ['owner', 'admin'].includes(actor?.role);
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
function text(value, { field, max, required = false, multiline = false }) {
  if (value === undefined || value === null) { if (required) fail(400, `Заполните поле «${field}»`); return ''; }
  if (typeof value !== 'string') fail(400, `Проверьте поле «${field}»`);
  let v = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (!multiline) v = v.replace(/[\r\n\t]+/g, ' ');
  v = v.trim();
  if (required && !v) fail(400, `Заполните поле «${field}»`);
  if (v.length > max) fail(400, `Поле «${field}» слишком длинное`);
  return v;
}
function only(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Проверьте данные');
  for (const key of Object.keys(body)) if (!keys.includes(key)) fail(400, 'Проверьте данные');
}
const phoneDigits = (value) => { const d = String(value).replace(/\D/g, ''); return d.length === 11 && d.startsWith('8') ? `7${d.slice(1)}` : d; };
/** Нормализованный контакт и ключ клиента. Ключ — сам контакт, никогда не имя. Телефон и WhatsApp — один номер. */
function normalizeContact(channel, raw) {
  const value = text(raw, { field: 'Контакт', max: 200, required: true });
  if (channel === 'phone' || channel === 'whatsapp') {
    const digits = phoneDigits(value);
    if (!/^[+\d\s().-]+$/.test(value) || digits.length < 10 || digits.length > 15) fail(400, 'Укажите телефон с кодом, например +7 900 000-00-00');
    return { channel, contact: value, key: `phone:${digits}` };
  }
  if (channel === 'telegram') {
    const handle = value.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/\/$/, '');
    if (!/^[a-z][a-z0-9_]{4,31}$/i.test(handle)) fail(400, 'Укажите Telegram в формате @username');
    const contact = `@${handle.toLowerCase()}`;
    return { channel, contact, key: `telegram:${contact}` };
  }
  if (channel === 'instagram') {
    let handle = value;
    const link = /^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(handle);
    if (link) handle = link[1];
    handle = handle.replace(/^@/, '');
    if (!/^[a-z0-9._]{1,30}$/i.test(handle) || /^\.|\.$|\.\./.test(handle)) fail(400, 'Укажите профиль Instagram: @имя или ссылку на профиль');
    const contact = `@${handle.toLowerCase()}`;
    return { channel, contact, key: `instagram:${contact}` };
  }
  if (channel === 'max') {
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value) || (/:/.test(value) && !/^https:\/\//i.test(value))) fail(400, 'Укажите контакт MAX без email и небезопасных ссылок');
    return { channel, contact: value, key: `max:${value.toLowerCase()}` };
  }
  fail(400, 'Выберите способ связи');
}
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function createWorkspace({ db, origin, now = Date.now, mode = 'demo', siteOrders = null, transact = null, priceReader = null,
  canAccessOrder = null, staffDirectory = null, notifier = null, teamNotifier = null, onOrderCreated = null, external = null, ipSalt = 'local-demo-only' } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Требуется SQLite');
  if (!['demo', 'integration'].includes(mode)) throw new TypeError('Неизвестный режим приложения');
  if (mode === 'integration' && (typeof canAccessOrder !== 'function' || typeof priceReader !== 'function' || !siteOrders
    || typeof transact !== 'function' || typeof staffDirectory !== 'function')) {
    throw new TypeError('Рабочий режим требует проверку прав, сотрудников, существующие заказы и общий прайс');
  }
  if (notifier !== null && (typeof notifier.register !== 'function' || typeof notifier.status !== 'function')) throw new TypeError('Некорректный модуль уведомлений');
  if (teamNotifier !== null && ['enqueue', 'jobs', 'status'].some((k) => typeof teamNotifier[k] !== 'function')) throw new TypeError('Некорректный модуль уведомлений команды');
  db.exec('PRAGMA foreign_keys=ON;');
  let depth = 0;
  // Рабочий режим обязан использовать ту же transact-функцию, что и действующий модуль заказов сайта.
  const tx = transact || ((fn) => {
    const name = `palitra_ws_${++depth}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    finally { depth--; }
  });
  const demoPrice = { categories: [
    { id: 'vypiska', title: 'Выписка', items: [{ id: 'demo-gold', title: 'Нежная встреча', price: '9 290 руб.' }] },
    { id: 'birthday', title: 'День рождения', items: [{ id: 'demo-birthday', title: 'День, полный счастья', price: '6 490 руб.' }] },
    { id: 'personal', title: 'Шары с надписью', items: [{ id: 'demo-bubble', title: 'Баблс с вашей надписью', price: '2 990 руб.' }] },
    { id: 'mama', title: 'Для мамы', items: [{ id: 'demo-heart', title: 'Сердце для мамы', price: '1 990 руб.' },
      { id: 'demo-custom', title: 'Композиция по эскизу', price: 'от 5 000' }] }
  ] };
  const readPrice = () => {
    let doc;
    try { const raw = priceReader ? priceReader(SITE) : demoPrice; doc = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { doc = null; }
    if (!doc || !Array.isArray(doc.categories)) fail(503, 'Прайс временно недоступен');
    return doc;
  };
  const priceItems = () => {
    const seen = new Set(), items = [];
    for (const cat of readPrice().categories) {
      for (const item of (Array.isArray(cat?.items) ? cat.items : [])) {
        if (!item || typeof item.id !== 'string' || !ITEM_ID.test(item.id) || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push({ id: item.id, title: String(item.title || item.id).slice(0, 120), category: String(cat.title || '').slice(0, 80), priceKopecks: priceKopecks(item.price) });
      }
    }
    return items;
  };
  const legacy = siteOrders || require('../vendor/site-orders').createSiteOrders({ db, tx, sites: { palitra: { companyCode: COMPANY, title: 'Palitra Love', origins: [origin] } }, priceReader: readPrice, ipSalt, now });
  const directory = () => {
    const list = staffDirectory ? staffDirectory() : DEMO_STAFF();
    return (Array.isArray(list) ? list : []).filter((m) => m && typeof m.id === 'string' && ['owner', 'admin'].includes(m.role))
      .map((m) => ({ id: m.id, name: String(m.name || '').slice(0, 80) || 'Сотрудник', role: m.role }));
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS palitra_crm_customers (
      id INTEGER PRIMARY KEY, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      name TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL, contact TEXT NOT NULL, contact_key TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company_code,contact_key)
    );
    CREATE TABLE IF NOT EXISTS palitra_crm_inquiries (
      id INTEGER PRIMARY KEY, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      source TEXT NOT NULL CHECK(source IN ('site','telegram','instagram','call')),
      origin TEXT NOT NULL CHECK(origin IN ('site_form','site_cart','app_customer','manual','telegram_hook','instagram_hook')),
      customer_id INTEGER NOT NULL REFERENCES palitra_crm_customers(id),
      name TEXT NOT NULL DEFAULT '', contact_channel TEXT NOT NULL, contact TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '', basis TEXT NOT NULL,
      marketing_consent TEXT NOT NULL DEFAULT 'unknown' CHECK(marketing_consent IN ('unknown','granted','declined')),
      consent_recorded_by TEXT, consent_recorded_at TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','converted','closed')), close_reason TEXT NOT NULL DEFAULT '',
      assignee_id TEXT, next_step TEXT NOT NULL DEFAULT '', due_at TEXT,
      site_order_id INTEGER UNIQUE, external_thread TEXT, external_ref TEXT UNIQUE, source_link TEXT,
      principal_provider TEXT, principal_subject TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, activity_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS palitra_crm_inquiries_thread ON palitra_crm_inquiries(external_thread, id);
    CREATE TABLE IF NOT EXISTS palitra_crm_orders (
      id INTEGER PRIMARY KEY, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      inquiry_id INTEGER NOT NULL UNIQUE REFERENCES palitra_crm_inquiries(id),
      customer_id INTEGER NOT NULL REFERENCES palitra_crm_customers(id), site_order_id INTEGER UNIQUE,
      items_json TEXT NOT NULL DEFAULT '[]', known_total INTEGER NOT NULL DEFAULT 0, unknown_count INTEGER NOT NULL DEFAULT 0,
      fulfillment TEXT NOT NULL CHECK(fulfillment IN ('delivery','pickup','courier')),
      delivery_date TEXT NOT NULL DEFAULT '', delivery_interval TEXT NOT NULL DEFAULT '', delivery_address TEXT NOT NULL DEFAULT '',
      wishes TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL DEFAULT 'new' CHECK(stage IN ('new','agreeing','awaiting_payment','preparing','photo','delivering','done')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled')),
      payment TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment IN ('unpaid','deposit','paid')), paid_kopecks INTEGER NOT NULL DEFAULT 0,
      photo_data TEXT NOT NULL DEFAULT '', photo_version TEXT, photo_approved_version TEXT, photo_change_version TEXT,
      photo_change_text TEXT NOT NULL DEFAULT '',
      cancel_reason TEXT NOT NULL DEFAULT '', cancelled_at TEXT, cancelled_stage TEXT,
      assignee_id TEXT, next_step TEXT NOT NULL DEFAULT '', due_at TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS palitra_crm_history (
      id INTEGER PRIMARY KEY, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      entity TEXT NOT NULL CHECK(entity IN ('inquiry','order')), entity_id INTEGER NOT NULL,
      label TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','staff')), actor TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS palitra_crm_history_entity ON palitra_crm_history(entity, entity_id, id);
    CREATE TABLE IF NOT EXISTS palitra_crm_notes (
      id INTEGER PRIMARY KEY, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      entity TEXT NOT NULL CHECK(entity IN ('inquiry','order')), entity_id INTEGER NOT NULL,
      text TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS palitra_crm_notes_entity ON palitra_crm_notes(entity, entity_id, id);
    CREATE TABLE IF NOT EXISTS palitra_crm_requests (
      company_code TEXT NOT NULL CHECK(company_code='palitra-love'), request_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, scope TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result_kind TEXT NOT NULL, result_id INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(company_code, request_id)
    );
  `);

  const at = () => new Date(now()).toISOString();
  const localDate = (ms = now()) => new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  const q = {
    customerByKey: db.prepare('SELECT * FROM palitra_crm_customers WHERE company_code=? AND contact_key=?'),
    customer: db.prepare('SELECT * FROM palitra_crm_customers WHERE company_code=? AND id=?'),
    inquiry: db.prepare('SELECT * FROM palitra_crm_inquiries WHERE company_code=? AND id=?'),
    inquiryBySite: db.prepare('SELECT * FROM palitra_crm_inquiries WHERE company_code=? AND site_order_id=?'),
    inquiryByRef: db.prepare('SELECT * FROM palitra_crm_inquiries WHERE company_code=? AND external_ref=?'),
    order: db.prepare('SELECT * FROM palitra_crm_orders WHERE company_code=? AND id=?'),
    orderByInquiry: db.prepare('SELECT * FROM palitra_crm_orders WHERE company_code=? AND inquiry_id=?'),
    request: db.prepare('SELECT * FROM palitra_crm_requests WHERE company_code=? AND request_id=?'),
    history: db.prepare('SELECT label,visibility,actor,created_at FROM palitra_crm_history WHERE company_code=? AND entity=? AND entity_id=? ORDER BY id'),
    notes: db.prepare('SELECT id,text,author,created_at FROM palitra_crm_notes WHERE company_code=? AND entity=? AND entity_id=? ORDER BY id')
  };
  const event = (entity, id, label, visibility, actorName) => db.prepare(`INSERT INTO palitra_crm_history(company_code,entity,entity_id,label,visibility,actor,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(COMPANY, entity, id, label, visibility, actorName, at());

  /* ---------- идемпотентность изменений ----------
     Тот же requestId с тем же телом от того же сотрудника — повтор: действие не выполняется второй раз,
     возвращается текущее состояние. Тот же requestId с другим телом или из другого аккаунта — 409. */
  function requestIdOf(body) {
    const id = typeof body?.requestId === 'string' ? body.requestId.toLowerCase() : '';
    if (!UUID_V4.test(id)) fail(400, 'Обновите страницу и повторите действие', 'REQUEST_ID');
    return id;
  }
  function replayOf(requestId, actor, scope, fingerprint) {
    const row = q.request.get(COMPANY, requestId);
    if (!row) return null;
    if (row.actor_id !== actor.id || row.scope !== scope || row.fingerprint !== fingerprint) fail(409, 'Это действие уже было сохранено с другими данными. Обновите карточку', 'REQUEST_MISMATCH');
    return row;
  }
  const remember = (requestId, actor, scope, fingerprint, kind, id) => db.prepare(`INSERT INTO palitra_crm_requests
    (company_code,request_id,actor_id,scope,fingerprint,result_kind,result_id,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(COMPANY, requestId, actor.id, scope, fingerprint, kind, id, at());
  const fingerprintOf = (body) => sha256(stable({ ...body, requestId: undefined }));

  /* ---------- клиенты ---------- */
  function customerFor({ key, channel, contact, name }) {
    const existing = q.customerByKey.get(COMPANY, key);
    if (existing) {
      if (name && !existing.name) db.prepare('UPDATE palitra_crm_customers SET name=?,updated_at=? WHERE id=?').run(name, at(), existing.id);
      return existing.id;
    }
    return Number(db.prepare(`INSERT INTO palitra_crm_customers(company_code,name,channel,contact,contact_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(COMPANY, name || '', channel, contact, key, at(), at()).lastInsertRowid);
  }
  function contactOfSiteRow(row) {
    const channel = row.contact_channel || 'phone';
    const contact = row.contact || row.phone;
    try { return normalizeContact(channel, contact); }
    catch { return { channel, contact, key: `${channel}:${String(contact).toLowerCase()}` }; }
  }

  /* ---------- срок ---------- */
  function parseDue(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') fail(400, 'Проверьте срок');
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
    if (!m || !validDate(m[1])) fail(400, 'Срок: выберите дату и, при желании, время');
    const hours = m[2] === undefined ? 23 : Number(m[2]), minutes = m[3] === undefined ? 59 : Number(m[3]);
    if (hours > 23 || minutes > 59) fail(400, 'Проверьте время срока');
    const [y, mo, d] = m[1].split('-').map(Number);
    return { iso: new Date(Date.UTC(y, mo - 1, d, hours, minutes) - TZ_OFFSET_MIN * 60000).toISOString(), hasTime: m[2] !== undefined };
  }
  const dueView = (iso) => {
    if (!iso) return null;
    const local = new Date(Date.parse(iso) + TZ_OFFSET_MIN * 60000).toISOString();
    return { at: iso, date: local.slice(0, 10), time: local.slice(11, 16) };
  };
  const assigneeView = (id) => {
    if (!id) return null;
    const member = directory().find((m) => m.id === id);
    return member ? { id, name: member.name, role: member.role } : { id, name: 'Нет доступа к Palitra', inactive: true };
  };
  function planOf(body, current = {}) {
    const assigneeId = body.assigneeId === undefined ? current.assignee_id ?? null : body.assigneeId;
    if (assigneeId !== null && (typeof assigneeId !== 'string' || !directory().some((m) => m.id === assigneeId))) {
      fail(400, 'Ответственным можно выбрать только сотрудника Palitra');
    }
    const nextStep = body.nextStep === undefined ? current.next_step ?? '' : text(body.nextStep, { field: 'Следующий шаг', max: 300 });
    const due = body.dueAt === undefined ? (current.due_at ? { iso: current.due_at } : null) : parseDue(body.dueAt);
    return { assigneeId, nextStep, dueAt: due ? due.iso : null };
  }

  /* ---------- состав и доставка ---------- */
  function itemsOf(input) {
    if (!Array.isArray(input) || input.length > 30) fail(400, 'Выберите от 1 до 30 позиций');
    const catalog = new Map(priceItems().map((p) => [p.id, p]));
    const seen = new Set();
    const items = input.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !catalog.has(entry.id) || seen.has(entry.id)
        || !Number.isInteger(entry.qty) || entry.qty < 1 || entry.qty > 20) fail(400, 'Проверьте состав заказа: позиции берутся из действующего прайса');
      seen.add(entry.id);
      const item = catalog.get(entry.id);
      return { id: item.id, title: item.title, qty: entry.qty, price: item.priceKopecks };
    });
    const knownTotal = items.reduce((sum, i) => sum + (i.price === null ? 0 : i.price * i.qty), 0);
    if (!Number.isSafeInteger(knownTotal)) fail(400, 'Сумма заказа слишком велика');
    return { items, knownTotal, unknownCount: items.filter((i) => i.price === null).length };
  }
  function detailsOf(body, current = null) {
    const fulfillment = body.fulfillment === undefined && current ? current.fulfillment : body.fulfillment;
    if (!FULFILLMENT.includes(fulfillment)) fail(400, 'Выберите: доставка, самовывоз или курьер клиента');
    const date = body.deliveryDate === undefined && current ? current.delivery_date : text(body.deliveryDate, { field: 'Дата', max: 10 });
    if (date && !validDate(date)) fail(400, 'Проверьте дату');
    if (date && date < localDate() && date !== current?.delivery_date) fail(400, 'Дата не может быть в прошлом');
    const interval = body.deliveryInterval === undefined && current ? current.delivery_interval : text(body.deliveryInterval, { field: 'Время', max: 80 });
    if (interval && interval !== current?.delivery_interval && !INTERVALS_FOR[fulfillment].includes(interval)) {
      fail(400, fulfillment === 'delivery' ? 'Выберите интервал из списка' : 'Самовывоз и курьер — с 09:00 до 21:00 или «Другое время»');
    }
    let address = body.deliveryAddress === undefined && current ? current.delivery_address : text(body.deliveryAddress, { field: 'Адрес', max: 500 });
    if (fulfillment === 'pickup') address = `Самовывоз: ${PICKUP_POINT}`;
    if (fulfillment === 'courier') address = `Курьер клиента заберёт заказ: ${PICKUP_POINT}`;
    if (fulfillment === 'delivery' && /^(Самовывоз|Курьер)/.test(address)) address = '';
    const wishes = body.wishes === undefined && current ? current.wishes : text(body.wishes, { field: 'Пожелания', max: 1000, multiline: true });
    return { fulfillment, date, interval, address, wishes };
  }
  const fulfillmentOfSite = (row) => /^Самовывоз/i.test(row.delivery_address) || /Способ получения:\s*Самовывоз/i.test(row.comment) ? 'pickup'
    : /^Курьер/i.test(row.delivery_address) || /Способ получения:\s*Курьер/i.test(row.comment) ? 'courier' : 'delivery';

  /* ---------- доступ ---------- */
  function inquiryRow(id) {
    const n = Number(id);
    const row = Number.isSafeInteger(n) && n > 0 ? q.inquiry.get(COMPANY, n) : null;
    if (!row) fail(404, 'Обращение не найдено');
    return row;
  }
  const ownsInquiry = (row, actor) => Boolean(actor.principal && row.principal_provider === actor.principal.provider
    && row.principal_subject === actor.principal.subject);
  function orderRow(id, actor) {
    scoped(actor);
    const n = Number(id);
    const row = Number.isSafeInteger(n) && n > 0 ? q.order.get(COMPANY, n) : null;
    if (!row) fail(404, 'Заказ не найден');
    if (!canSee(row, actor)) fail(404, 'Заказ не найден');
    return row;
  }
  function canSee(row, actor) {
    if (canAccessOrder) return canAccessOrder(row.id, actor) === true;
    if (isStaff(actor)) return true;
    if (actor.role !== 'customer') return false;
    // Демонстрация: собственные заявки «клиента» и заказы вымышленной Анны.
    const inquiry = q.inquiry.get(COMPANY, row.inquiry_id);
    return ownsInquiry(inquiry, actor) || (actor.id === ACTORS.customer.id && row.customer_id === demoCustomerId());
  }
  const demoCustomerId = () => q.customerByKey.get(COMPANY, 'telegram:@demo_anna')?.id ?? -1;

  /* ---------- представления ---------- */
  const photoView = (row) => row.photo_version ? {
    version: row.photo_version, approved: row.photo_approved_version === row.photo_version,
    changeRequested: row.photo_change_version === row.photo_version } : null;
  function nextActionText(row) {
    if (row.status === 'cancelled') return 'Заказ отменён';
    if (row.status === 'done') return 'Заказ выполнен. Памятка доступна клиенту';
    const photo = photoView(row);
    switch (row.stage) {
      case 'new': return 'Связаться с клиентом и начать согласование';
      case 'agreeing': return row.unknown_count || !JSON.parse(row.items_json).length ? 'Уточнить состав и цену' : 'Подтвердить состав и перейти к оплате';
      case 'awaiting_payment': return row.payment === 'unpaid' ? 'Дождаться оплаты и отметить её' : 'Оплата отмечена — начинайте подготовку';
      case 'preparing': return row.photo_version ? 'Показать фото клиенту' : 'Собрать заказ и прикрепить фото';
      case 'photo': return photo?.changeRequested ? 'Клиент просит изменить фото — замените снимок' : 'Передать заказ в доставку';
      case 'delivering': return row.payment === 'paid' ? 'Доставить или выдать заказ' : 'Отметить полную оплату и завершить заказ';
      default: return '';
    }
  }
  function overdue(row, active) { return Boolean(active && row.due_at && Date.parse(row.due_at) < now()); }
  function history(entity, id, actor) {
    return q.history.all(COMPANY, entity, id).filter((h) => isStaff(actor) || h.visibility === 'public')
      .map((h) => ({ label: h.label, createdAt: h.created_at, ...(isStaff(actor) ? { actor: h.actor } : {}) }));
  }
  const notes = (entity, id) => q.notes.all(COMPANY, entity, id).map((n) => ({ id: n.id, text: n.text, author: n.author, createdAt: n.created_at }));
  function customerBrief(id) {
    const c = q.customer.get(COMPANY, id);
    return c ? { id: c.id, name: c.name, channel: c.channel, channelLabel: CHANNEL_LABELS[c.channel] || c.channel, contact: c.contact } : null;
  }
  function orderView(row, actor, { detail = false } = {}) {
    const items = JSON.parse(row.items_json);
    // Клиент видит фото только после того, как сотрудник показал его (этап «Фото» и дальше).
    const photo = isStaff(actor) || ['photo', 'delivering', 'done'].includes(row.stage) ? photoView(row) : null;
    const base = {
      id: row.id, createdAt: row.created_at, stage: row.stage, stageLabel: LABELS[row.stage], status: row.status,
      items, knownTotal: row.known_total, unknownCount: row.unknown_count,
      fulfillment: row.fulfillment, fulfillmentLabel: FULFILLMENT_LABELS[row.fulfillment],
      deliveryDate: row.delivery_date, deliveryInterval: row.delivery_interval, deliveryAddress: row.delivery_address, wishes: row.wishes,
      payment: row.payment, paidKopecks: row.paid_kopecks, photo: photo ? { ...photo, ...(detail ? { url: row.photo_data } : {}) } : null,
      guide: row.status === 'done' ? GUIDE : null, cancelled: row.status === 'cancelled'
    };
    if (!isStaff(actor)) return { ...base, history: detail ? history('order', row.id, actor) : undefined };
    const inquiry = q.inquiry.get(COMPANY, row.inquiry_id);
    return {
      ...base, version: row.version, inquiryId: row.inquiry_id, siteOrderId: row.site_order_id, source: inquiry.source, origin: inquiry.origin,
      customer: customerBrief(row.customer_id), name: inquiry.name || customerBrief(row.customer_id)?.name || '',
      assignee: assigneeView(row.assignee_id), nextStep: row.next_step, due: dueView(row.due_at), overdue: overdue(row, row.status === 'active'),
      nextAction: nextActionText(row), cancelReason: row.cancel_reason, cancelledStage: row.cancelled_stage,
      photoChangeText: photo?.changeRequested ? row.photo_change_text : '',
      ...(detail ? { notes: notes('order', row.id), history: history('order', row.id, actor),
        notification: notifier ? notifier.status(row.inquiry_id) : { status: 'not_configured' },
        primaryNotification: primaryView(inquiry) } : {})
    };
  }
  function inquiryView(row, actor, { detail = false } = {}) {
    staff(actor);
    const order = q.orderByInquiry.get(COMPANY, row.id);
    const view = {
      id: row.id, source: row.source, sourceLabel: SOURCE_LABELS[row.source], origin: row.origin, status: row.status,
      customer: customerBrief(row.customer_id), name: row.name, contactChannel: row.contact_channel,
      contactChannelLabel: CHANNEL_LABELS[row.contact_channel] || row.contact_channel, contact: row.contact,
      summary: row.summary, outcome: row.outcome, basis: row.basis, basisLabel: BASIS[row.basis] || row.basis,
      marketingConsent: row.marketing_consent, closeReason: row.close_reason,
      orderId: order?.id ?? null, orderStage: order?.stage ?? null, siteOrderId: row.site_order_id,
      assignee: assigneeView(row.assignee_id), nextStep: row.next_step, due: dueView(row.due_at), overdue: overdue(row, row.status === 'open'),
      createdAt: row.created_at, activityAt: row.activity_at, version: row.version, sourceLink: row.source_link || null,
      // Полная переписка есть только у подключённого входящего канала. Ручная запись — краткий итог сотрудника.
      conversation: ['telegram_hook', 'instagram_hook'].includes(row.origin) ? 'connected' : row.origin === 'manual' ? 'manual_summary' : 'site_form'
    };
    if (!detail) return view;
    let channelMessages = null;
    if (view.conversation === 'connected' && external?.messages) {
      try { channelMessages = external.messages(row, actor); } catch { channelMessages = null; }
    }
    return { ...view, notes: notes('inquiry', row.id), history: history('inquiry', row.id, actor), channelMessages,
      consentRecordedBy: row.consent_recorded_by, consentRecordedAt: row.consent_recorded_at,
      notification: notifier ? notifier.status(row.id) : { status: 'not_configured' }, primaryNotification: primaryView(row) };
  }

  /* ---------- создание обращений ---------- */
  function insertInquiry(fields) {
    const stamp = at();
    const id = Number(db.prepare(`INSERT INTO palitra_crm_inquiries(company_code,source,origin,customer_id,name,contact_channel,contact,summary,outcome,
      basis,marketing_consent,consent_recorded_by,consent_recorded_at,status,assignee_id,next_step,due_at,site_order_id,external_thread,external_ref,
      source_link,principal_provider,principal_subject,created_by,created_at,updated_at,activity_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(COMPANY, fields.source, fields.origin, fields.customerId, fields.name || '',
      fields.channel, fields.contact, fields.summary || '', fields.outcome || '', fields.basis, fields.marketing || 'unknown',
      fields.consentBy || null, fields.consentBy ? stamp : null, fields.status || 'open', fields.assigneeId || null, fields.nextStep || '',
      fields.dueAt || null, fields.siteOrderId ?? null, fields.thread ?? null, fields.externalRef ?? null, fields.sourceLink ?? null,
      fields.principal?.provider ?? null, fields.principal?.subject ?? null, fields.createdBy, stamp, stamp, stamp).lastInsertRowid);
    return q.inquiry.get(COMPANY, id);
  }
  function insertOrder(inquiry, fields, createdBy) {
    const stamp = at();
    const id = Number(db.prepare(`INSERT INTO palitra_crm_orders(company_code,inquiry_id,customer_id,site_order_id,items_json,known_total,unknown_count,
      fulfillment,delivery_date,delivery_interval,delivery_address,wishes,assignee_id,next_step,due_at,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(COMPANY, inquiry.id, inquiry.customer_id, fields.siteOrderId ?? null,
      JSON.stringify(fields.items), fields.knownTotal, fields.unknownCount, fields.fulfillment, fields.date || '', fields.interval || '',
      fields.address || '', fields.wishes || '', inquiry.assignee_id, '', null, createdBy, stamp, stamp).lastInsertRowid);
    db.prepare("UPDATE palitra_crm_inquiries SET status='converted',updated_at=?,version=version+1 WHERE id=?").run(stamp, inquiry.id);
    const order = q.order.get(COMPANY, id);
    if (onOrderCreated) onOrderCreated({ orderId: id, inquiry: q.inquiry.get(COMPANY, inquiry.id) });
    return order;
  }

  /** Сотрудник записывает обращение из Instagram, Telegram или звонка. Источник «сайт» вручную не выбирается. */
  function createInquiry(body, actor) {
    staff(actor);
    only(body, ['requestId', 'source', 'name', 'contactChannel', 'contact', 'summary', 'outcome', 'basis', 'marketingConsent', 'assigneeId', 'nextStep', 'dueAt']);
    const requestId = requestIdOf(body);
    if (!MANUAL_SOURCES.includes(body.source)) fail(400, 'Источник: Instagram, Telegram или звонок. Заявки сайта приходят сами');
    if (!MANUAL_CHANNELS[body.source].includes(body.contactChannel)) fail(400, body.source === 'call' ? 'Для звонка укажите номер телефона' : 'Выберите вид контакта');
    const contact = normalizeContact(body.contactChannel, body.contact);
    const name = text(body.name, { field: 'Имя', max: 80 });
    const summary = text(body.summary, { field: 'Суть обращения', max: 1000, required: true, multiline: true });
    const outcome = text(body.outcome, { field: 'Итог разговора', max: 2000, multiline: true });
    if (!MANUAL_BASIS.includes(body.basis)) fail(400, 'Отметьте, как клиент обратился');
    const marketing = body.marketingConsent === undefined ? 'unknown' : body.marketingConsent;
    if (!MARKETING.includes(marketing)) fail(400, 'Проверьте отметку о рассылке');
    const plan = planOf(body);
    const fingerprint = fingerprintOf(body);
    return tx(() => {
      const replay = replayOf(requestId, actor, 'inquiry:create', fingerprint);
      if (replay) return { status: 200, duplicate: true, inquiry: inquiryView(inquiryRow(replay.result_id), actor, { detail: true }) };
      const customerId = customerFor({ ...contact, name });
      const row = insertInquiry({ source: body.source, origin: 'manual', customerId, name, channel: contact.channel, contact: contact.contact,
        summary, outcome, basis: body.basis, marketing, consentBy: marketing === 'unknown' ? null : actor.name, assigneeId: plan.assigneeId,
        nextStep: plan.nextStep, dueAt: plan.dueAt, createdBy: actor.name });
      event('inquiry', row.id, `Обращение записано вручную · ${SOURCE_LABELS[body.source]}`, 'staff', actor.name);
      if (marketing !== 'unknown') event('inquiry', row.id, marketing === 'granted' ? 'Отмечено: клиент согласился на рассылку' : 'Отмечено: клиент отказался от рассылки', 'staff', actor.name);
      // Политика: каждое новое обращение (и ручное тоже) ставится под наблюдение резервной почты собственника
      // в той же транзакции. Основного уведомления команде у ручной записи нет, поэтому письмо возможно после
      // паузы — только если Дарья включила почту и хост подключил отправку. Повтор requestId не регистрирует второй раз.
      if (notifier) notifier.register(row.id);
      // Основной канал: личное сообщение менеджеру через существующий бот хоста (очередь team-notify).
      if (teamNotifier) teamNotifier.enqueue(row.id, body.source);
      remember(requestId, actor, 'inquiry:create', fingerprint, 'inquiry', row.id);
      return { status: 201, duplicate: false, inquiry: inquiryView(row, actor, { detail: true }) };
    });
  }

  /** Публичная форма/корзина сайта (или заказ клиента в приложении) через неизменённый модуль заказов сайта. */
  function submitSite(body, { ip = '127.0.0.1', requestOrigin = origin, principal = null, appCustomer = false } = {}) {
    return tx(() => {
      const result = legacy.submit({ site: SITE, body, origin: requestOrigin, ip });
      const siteId = result.body.orderId;
      if (!siteId) return { result, inquiryId: null, orderId: null, created: false };
      const existing = q.inquiryBySite.get(COMPANY, siteId);
      if (existing) return { result, inquiryId: existing.id, orderId: q.orderByInquiry.get(COMPANY, existing.id)?.id ?? null, created: false };
      // Повтор чужой/старой заявки не закрепляет её за вошедшим клиентом: principal только у новой.
      const fresh = result.status === 201;
      const linked = attachSite(siteId, { principal: fresh ? principal : null, appCustomer: fresh && appCustomer, register: fresh });
      return { result, ...linked, created: result.status === 201 };
    });
  }
  function attachSite(siteId, { principal = null, appCustomer = false, register = false } = {}) {
    const row = db.prepare('SELECT * FROM site_orders WHERE id=? AND site=? AND company_code=?').get(siteId, SITE, COMPANY);
    if (!row) fail(404, 'Заявка сайта не найдена');
    const contact = contactOfSiteRow(row);
    const customerId = customerFor({ ...contact, name: row.name });
    const items = JSON.parse(row.items_json);
    const inquiry = insertInquiry({ source: 'site', origin: appCustomer ? 'app_customer' : row.kind === 'cart' ? 'site_cart' : 'site_form',
      customerId, name: row.name, channel: contact.channel, contact: contact.contact, summary: row.comment || (items.length ? 'Заказ из корзины' : 'Заявка на подбор'),
      basis: appCustomer ? 'app_request' : 'site_request', siteOrderId: siteId, principal, createdBy: appCustomer ? 'Приложение' : 'Сайт' });
    event('inquiry', inquiry.id, appCustomer ? 'Заявка оформлена клиентом в приложении' : `Заявка с сайта №${siteId}`, 'public', appCustomer ? 'Клиент' : 'Сайт');
    let orderId = null;
    if (row.kind === 'cart' && items.length) {
      const fulfillment = fulfillmentOfSite(row);
      const order = insertOrder(inquiry, { siteOrderId: siteId, items, knownTotal: row.known_total, unknownCount: row.unknown_count,
        fulfillment, date: row.delivery_date, interval: row.delivery_interval, address: row.delivery_address, wishes: row.comment }, 'Сайт');
      event('order', order.id, 'Заказ получен', 'public', appCustomer ? 'Клиент' : 'Сайт');
      orderId = order.id;
    }
    if (register && notifier) notifier.register(inquiry.id);
    return { inquiryId: inquiry.id, orderId };
  }
  // Ранее принятые заявки сайта присоединяются явно хостом, без новых уведомлений.
  function attachExisting(siteId) {
    return tx(() => {
      const existing = q.inquiryBySite.get(COMPANY, Number(siteId));
      if (existing) return { inquiryId: existing.id, orderId: q.orderByInquiry.get(COMPANY, existing.id)?.id ?? null, created: false };
      return { ...attachSite(Number(siteId), { register: false }), created: true };
    });
  }

  /**
   * Обращение из подключённого входящего канала (Telegram/Instagram hook хоста). Одна беседа — одно открытое
   * обращение: новое сообщение обновляет время активности, после закрытия создаётся новое обращение.
   * Вызывать только из серверного кода после проверки подлинности события.
   */
  function recordExternalInquiry({ source, thread, customer, summary, sourceLink = null, historical = false }) {
    if (!['telegram', 'instagram'].includes(source)) fail(400, 'Неизвестный канал');
    if (typeof thread !== 'string' || !/^[a-z]{2,10}:[A-Za-z0-9:_-]{1,200}$/.test(thread)) fail(400, 'Некорректная беседа канала');
    if (!customer || !/^\d{1,24}$/.test(String(customer.id))) fail(400, 'Некорректный отправитель');
    return tx(() => {
      // Беседа канала определяет обращение; закрытое не продолжается — новое сообщение создаёт новое обращение.
      const latest = db.prepare(`SELECT * FROM palitra_crm_inquiries WHERE company_code=? AND external_thread=? ORDER BY id DESC LIMIT 1`).get(COMPANY, thread);
      if (latest && latest.status !== 'closed') {
        db.prepare('UPDATE palitra_crm_inquiries SET activity_at=? WHERE id=?').run(at(), latest.id);
        return { inquiryId: latest.id, created: false };
      }
      const kind = source === 'telegram' ? 'telegram_id' : 'instagram_id';
      const name = text(customer.name, { field: 'Имя', max: 80 });
      const customerId = customerFor({ key: `${kind === 'telegram_id' ? 'tgid' : 'igsid'}:${customer.id}`, channel: kind,
        contact: name ? `${name} · ${SOURCE_LABELS[source]}` : `${SOURCE_LABELS[source]} · клиент`, name });
      const row = insertInquiry({ source, origin: `${source}_hook`, customerId, name, channel: kind,
        contact: q.customer.get(COMPANY, customerId).contact, summary: text(summary, { field: 'Сообщение', max: 1000, multiline: true }) || 'Входящее сообщение',
        basis: 'channel_message', thread, sourceLink, createdBy: SOURCE_LABELS[source] });
      event('inquiry', row.id, `Новое сообщение в ${SOURCE_LABELS[source]}`, 'staff', SOURCE_LABELS[source]);
      if (!historical && notifier) notifier.register(row.id);
      // Входящий Telegram уведомляет команду через telegram-ingest; Instagram — через общую очередь команды.
      if (!historical && source === 'instagram' && teamNotifier) teamNotifier.enqueue(row.id, 'instagram');
      return { inquiryId: row.id, created: true };
    });
  }

  /* ---------- действия с обращением ---------- */
  function inquiryAction(id, body, actor) {
    staff(actor);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Проверьте действие');
    const requestId = requestIdOf(body);
    const fingerprint = fingerprintOf(body);
    const scope = `inquiry:${Number(id)}:action`;
    return tx(() => {
      const current = inquiryRow(id);
      const replay = replayOf(requestId, actor, scope, fingerprint);
      if (replay) return { ok: true, replayed: true, inquiry: inquiryView(inquiryRow(id), actor, { detail: true }),
        ...(replay.result_kind === 'order' ? { orderId: replay.result_id } : {}) };
      if (body.action !== 'note' && body.version !== current.version) fail(409, 'Карточка уже изменилась. Проверьте свежие данные', 'STALE');
      const stamp = at();
      let result = { kind: 'inquiry', id: current.id };
      const bump = (sql, ...args) => {
        const changes = Number(db.prepare(`UPDATE palitra_crm_inquiries SET ${sql},updated_at=?,version=version+1 WHERE id=? AND version=?`)
          .run(...args, stamp, current.id, current.version).changes);
        if (changes !== 1) fail(409, 'Карточка уже изменилась. Проверьте свежие данные', 'STALE');
      };
      switch (body.action) {
        case 'plan': {
          only(body, ['requestId', 'action', 'version', 'assigneeId', 'nextStep', 'dueAt']);
          if (current.status === 'closed') fail(409, 'Обращение закрыто');
          const plan = planOf(body, current);
          bump('assignee_id=?,next_step=?,due_at=?', plan.assigneeId, plan.nextStep, plan.dueAt);
          const who = assigneeView(plan.assigneeId);
          event('inquiry', current.id, `План: ${who ? who.name : 'без ответственного'}${plan.nextStep ? ` · ${plan.nextStep}` : ''}`, 'staff', actor.name);
          break;
        }
        case 'details': {
          only(body, ['requestId', 'action', 'version', 'name', 'summary', 'outcome']);
          if (current.status === 'closed') fail(409, 'Обращение закрыто');
          const name = body.name === undefined ? current.name : text(body.name, { field: 'Имя', max: 80 });
          const summary = body.summary === undefined ? current.summary : text(body.summary, { field: 'Суть обращения', max: 1000, required: true, multiline: true });
          const outcome = body.outcome === undefined ? current.outcome : text(body.outcome, { field: 'Итог разговора', max: 2000, multiline: true });
          bump('name=?,summary=?,outcome=?', name, summary, outcome);
          if (name && name !== current.name) db.prepare("UPDATE palitra_crm_customers SET name=?,updated_at=? WHERE id=? AND name=''").run(name, stamp, current.customer_id);
          event('inquiry', current.id, 'Данные обращения уточнены', 'staff', actor.name);
          break;
        }
        case 'consent': {
          only(body, ['requestId', 'action', 'version', 'marketingConsent']);
          if (!MARKETING.includes(body.marketingConsent)) fail(400, 'Проверьте отметку о рассылке');
          bump('marketing_consent=?,consent_recorded_by=?,consent_recorded_at=?', body.marketingConsent,
            body.marketingConsent === 'unknown' ? null : actor.name, body.marketingConsent === 'unknown' ? null : stamp);
          event('inquiry', current.id, { unknown: 'Отметка о рассылке снята', granted: 'Отмечено: клиент согласился на рассылку', declined: 'Отмечено: клиент отказался от рассылки' }[body.marketingConsent], 'staff', actor.name);
          break;
        }
        case 'note': {
          only(body, ['requestId', 'action', 'text']);
          const value = text(body.text, { field: 'Заметка', max: 2000, required: true, multiline: true });
          db.prepare('INSERT INTO palitra_crm_notes(company_code,entity,entity_id,text,author,created_at) VALUES(?,?,?,?,?,?)').run(COMPANY, 'inquiry', current.id, value, actor.name, stamp);
          db.prepare('UPDATE palitra_crm_inquiries SET activity_at=? WHERE id=?').run(stamp, current.id);
          break;
        }
        case 'close': {
          only(body, ['requestId', 'action', 'version', 'reason']);
          if (current.status !== 'open') fail(409, current.status === 'converted' ? 'По обращению уже оформлен заказ' : 'Обращение уже закрыто');
          const reason = text(body.reason, { field: 'Причина', max: 300, required: true });
          bump("status='closed',close_reason=?", reason);
          event('inquiry', current.id, `Обращение закрыто: ${reason}`, 'staff', actor.name);
          if (external?.status) external.status(current, 'closed', actor);
          break;
        }
        case 'reopen': {
          only(body, ['requestId', 'action', 'version']);
          if (current.status !== 'closed') fail(409, 'Обращение не закрыто');
          // Сообщения канала после закрытия уже создают новое обращение — повторно открывать их нельзя.
          if (current.origin.endsWith('_hook')) fail(409, 'Новое сообщение клиента создаст новое обращение');
          bump("status='open',close_reason=''");
          event('inquiry', current.id, 'Обращение снова открыто', 'staff', actor.name);
          break;
        }
        case 'convert': {
          only(body, ['requestId', 'action', 'version', 'items', 'fulfillment', 'deliveryDate', 'deliveryInterval', 'deliveryAddress', 'wishes']);
          if (current.status !== 'open') fail(409, current.status === 'converted' ? 'По обращению уже оформлен заказ' : 'Обращение закрыто');
          if (q.orderByInquiry.get(COMPANY, current.id)) fail(409, 'По обращению уже оформлен заказ');
          const priced = itemsOf(body.items === undefined ? [] : body.items);
          const details = detailsOf(body);
          // Тот же заказ сайта не дублируется: связь site_order_id переносится, новая заявка не создаётся.
          const order = insertOrder(current, { ...priced, siteOrderId: current.site_order_id, ...details }, actor.name);
          event('inquiry', current.id, `Оформлен заказ №${order.id}`, 'staff', actor.name);
          event('order', order.id, 'Заказ оформлен', 'public', actor.name);
          if (external?.status) external.status(current, 'converted', actor);
          result = { kind: 'order', id: order.id };
          break;
        }
        default: fail(400, 'Действие не поддерживается');
      }
      remember(requestId, actor, scope, fingerprint, result.kind, result.id);
      return { ok: true, replayed: false, inquiry: inquiryView(inquiryRow(id), actor, { detail: true }), ...(result.kind === 'order' ? { orderId: result.id } : {}) };
    });
  }

  /* ---------- действия с заказом ---------- */
  function validPhoto(dataUrl) {
    const url = text(dataUrl, { field: 'Фото', max: 4300000 });
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match) fail(400, 'Выберите фотографию JPEG, PNG или WebP');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 3 * 1024 * 1024) fail(400, 'Фото должно быть меньше 3 МБ');
    const ok = (match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      || (match[1] === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (match[1] === 'webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (!ok) fail(400, 'Не удалось прочитать фотографию');
    return url;
  }
  function orderAction(id, body, actor) {
    scoped(actor);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Проверьте действие');
    const customerAction = ['approve_photo', 'request_photo_change'].includes(body.action);
    if (customerAction ? actor.role !== 'customer' : !isStaff(actor)) {
      // Чужой заказ не раскрывается даже кодом ошибки.
      orderRow(id, actor);
      fail(403, customerAction ? 'Фото подтверждает клиент' : 'Действие доступно сотруднику Palitra');
    }
    const requestId = requestIdOf(body);
    const fingerprint = fingerprintOf(body);
    const scope = `order:${Number(id)}:action`;
    return tx(() => {
      const current = orderRow(id, actor);
      const replay = replayOf(requestId, actor, scope, fingerprint);
      if (replay) return { ok: true, replayed: true, order: orderView(orderRow(id, actor), actor, { detail: true }) };
      if (current.status !== 'active' && body.action !== 'note') {
        fail(409, current.status === 'cancelled' ? 'Заказ отменён — изменения закрыты' : 'Заказ выполнен — изменения закрыты', 'TERMINAL');
      }
      if (!customerAction && body.action !== 'note' && body.version !== current.version) fail(409, 'Заказ уже изменился. Проверьте свежие данные', 'STALE');
      const stamp = at();
      const bump = (sql, ...args) => {
        const changes = Number(db.prepare(`UPDATE palitra_crm_orders SET ${sql},updated_at=?,version=version+1 WHERE id=? AND version=?`)
          .run(...args, stamp, current.id, current.version).changes);
        if (changes !== 1) fail(409, 'Заказ уже изменился. Проверьте свежие данные', 'STALE');
      };
      const photo = photoView(current);
      switch (body.action) {
        case 'plan': {
          only(body, ['requestId', 'action', 'version', 'assigneeId', 'nextStep', 'dueAt']);
          const plan = planOf(body, current);
          bump('assignee_id=?,next_step=?,due_at=?', plan.assigneeId, plan.nextStep, plan.dueAt);
          const who = assigneeView(plan.assigneeId);
          event('order', current.id, `План: ${who ? who.name : 'без ответственного'}${plan.nextStep ? ` · ${plan.nextStep}` : ''}`, 'staff', actor.name);
          break;
        }
        case 'note': {
          only(body, ['requestId', 'action', 'text']);
          const value = text(body.text, { field: 'Заметка', max: 2000, required: true, multiline: true });
          db.prepare('INSERT INTO palitra_crm_notes(company_code,entity,entity_id,text,author,created_at) VALUES(?,?,?,?,?,?)').run(COMPANY, 'order', current.id, value, actor.name, stamp);
          break;
        }
        case 'items': {
          only(body, ['requestId', 'action', 'version', 'items']);
          if (!ITEMS_STAGES.includes(current.stage) || current.paid_kopecks > 0) fail(409, 'Состав уже подтверждён оплатой');
          const priced = itemsOf(body.items);
          if (!priced.items.length) fail(400, 'Выберите хотя бы одну позицию');
          bump('items_json=?,known_total=?,unknown_count=?', JSON.stringify(priced.items), priced.knownTotal, priced.unknownCount);
          event('order', current.id, 'Состав заказа обновлён', 'public', actor.name);
          break;
        }
        case 'details': {
          only(body, ['requestId', 'action', 'version', 'fulfillment', 'deliveryDate', 'deliveryInterval', 'deliveryAddress', 'wishes']);
          if (!DETAILS_STAGES.includes(current.stage)) fail(409, 'Заказ уже передан в доставку');
          const d = detailsOf(body, current);
          bump('fulfillment=?,delivery_date=?,delivery_interval=?,delivery_address=?,wishes=?', d.fulfillment, d.date, d.interval, d.address, d.wishes);
          event('order', current.id, `Получение: ${FULFILLMENT_LABELS[d.fulfillment]}${d.date ? `, ${d.date}` : ''}${d.interval ? ` ${d.interval}` : ''}`, 'public', actor.name);
          break;
        }
        case 'stage': {
          only(body, ['requestId', 'action', 'version', 'value']);
          const next = STAGES[STAGES.indexOf(current.stage) + 1];
          if (!next || body.value !== next) fail(409, 'Этап уже изменён. Обновите карточку', 'STALE');
          const items = JSON.parse(current.items_json);
          if (next === 'awaiting_payment' && (!items.length || current.unknown_count || current.known_total <= 0)) fail(409, 'Сначала согласуйте состав и цену всех позиций');
          if (next === 'preparing' && current.payment === 'unpaid') fail(409, 'Сначала отметьте оплату или предоплату');
          if (next === 'photo' && !current.photo_version) fail(409, 'Сначала прикрепите фото заказа');
          if (next === 'delivering' && photo?.changeRequested) fail(409, 'Клиент просит изменить фото — замените снимок');
          if (next === 'delivering' && !current.delivery_date) fail(409, 'Укажите дату получения');
          if (next === 'delivering' && current.fulfillment === 'delivery' && !current.delivery_address) fail(409, 'Укажите адрес доставки');
          // Время обязательно для всех способов: интервал из списка или явное «Другое время — согласовать».
          if (next === 'delivering' && !current.delivery_interval) fail(409, 'Выберите время получения');
          // Выполненный заказ закрыт для изменений, поэтому остаток отмечается ДО завершения.
          if (next === 'done' && current.payment !== 'paid') fail(409, 'Сначала отметьте полную оплату — после выполнения изменения закрыты');
          bump(next === 'done' ? "stage=?,status='done'" : 'stage=?', next);
          event('order', current.id, STAGE_EVENTS[next], 'public', actor.name);
          if (next === 'done') event('order', current.id, 'Памятка по уходу доступна клиенту', 'public', actor.name);
          if (current.site_order_id) legacy.setWorkStatus(SITE, current.site_order_id, next === 'done' ? 'done' : 'in_work', actor.name);
          break;
        }
        case 'payment': {
          only(body, ['requestId', 'action', 'version', 'value', 'amountKopecks']);
          if (current.stage === 'done') fail(409, 'Заказ выполнен');
          const total = current.known_total;
          if (current.unknown_count) fail(409, 'Сначала уточните стоимость всех позиций');
          if (!['deposit', 'paid'].includes(body.value) || !Number.isSafeInteger(body.amountKopecks) || body.amountKopecks <= 0 || !total || body.amountKopecks > total) fail(400, 'Проверьте сумму оплаты');
          if (body.value === 'paid' && body.amountKopecks !== total) fail(400, 'Полная оплата должна совпадать с суммой заказа');
          if (body.value === 'deposit' && body.amountKopecks >= total) fail(400, 'Предоплата должна быть меньше суммы заказа');
          if (body.amountKopecks < current.paid_kopecks) fail(409, 'Уменьшение оплаты требует отдельного возврата');
          bump('payment=?,paid_kopecks=?', body.value, body.amountKopecks);
          event('order', current.id, body.value === 'paid' ? 'Оплата подтверждена' : 'Предоплата подтверждена', 'public', actor.name);
          break;
        }
        case 'photo': {
          only(body, ['requestId', 'action', 'version', 'dataUrl']);
          if (!['preparing', 'photo'].includes(current.stage)) fail(409, 'Фото добавляется на этапе подготовки');
          const url = validPhoto(body.dataUrl);
          // Каждая публикация — новая версия, даже если загружен прежний снимок: прежние подтверждение и
          // запрос изменений сбрасываются, клиент согласует именно то, что показано сейчас.
          const version = sha256(`${current.id}:${current.version}:${stamp}:${sha256(url)}`);
          bump('photo_data=?,photo_version=?,photo_approved_version=NULL,photo_change_version=NULL,photo_change_text=?', url, version, '');
          event('order', current.id, current.photo_version ? 'Фото заказа заменено' : 'Фото заказа добавлено', 'public', actor.name);
          break;
        }
        case 'cancel': {
          only(body, ['requestId', 'action', 'version', 'reason']);
          const reason = text(body.reason, { field: 'Причина отмены', max: 300, required: true });
          // Состояние оплаты не сбрасывается: возврат денег — отдельное решение.
          bump("status='cancelled',cancel_reason=?,cancelled_at=?,cancelled_stage=?", reason, stamp, current.stage);
          event('order', current.id, 'Заказ отменён', 'public', actor.name);
          event('order', current.id, `Причина отмены: ${reason}${current.paid_kopecks ? ` · оплачено ${current.paid_kopecks / 100} ₽ — решить возврат` : ''}`, 'staff', actor.name);
          if (current.site_order_id) legacy.setWorkStatus(SITE, current.site_order_id, 'cancelled', actor.name);
          break;
        }
        case 'approve_photo':
        case 'request_photo_change': {
          only(body, body.action === 'approve_photo' ? ['requestId', 'action', 'photoVersion'] : ['requestId', 'action', 'photoVersion', 'comment']);
          if (current.stage !== 'photo') fail(409, current.stage === 'preparing' ? 'Фото ещё не показано' : 'Фото уже согласовано');
          if (!photo) fail(409, 'Фото ещё не добавлено');
          if (body.photoVersion !== current.photo_version) fail(409, 'Фотография обновилась. Посмотрите новый снимок', 'PHOTO_CHANGED');
          if (body.action === 'approve_photo') {
            if (!photo.approved) {
              db.prepare('UPDATE palitra_crm_orders SET photo_approved_version=?,photo_change_version=NULL,updated_at=?,version=version+1 WHERE id=?').run(current.photo_version, stamp, current.id);
              event('order', current.id, 'Клиент подтвердил фото', 'public', 'Клиент');
            }
          } else {
            const comment = text(body.comment, { field: 'Что изменить', max: 500, required: true, multiline: true });
            db.prepare('UPDATE palitra_crm_orders SET photo_change_version=?,photo_change_text=?,photo_approved_version=NULL,updated_at=?,version=version+1 WHERE id=?')
              .run(current.photo_version, comment, stamp, current.id);
            event('order', current.id, 'Клиент попросил изменить фото', 'public', 'Клиент');
          }
          break;
        }
        default: fail(400, 'Действие не поддерживается');
      }
      remember(requestId, actor, scope, fingerprint, 'order', current.id);
      return { ok: true, replayed: false, order: orderView(orderRow(id, actor), actor, { detail: true }) };
    });
  }

  /* ---------- чтение ---------- */
  const ordersFor = (actor) => db.prepare('SELECT * FROM palitra_crm_orders WHERE company_code=? ORDER BY id DESC LIMIT 500').all(COMPANY).filter((row) => canSee(row, actor));
  function customersList(actor) {
    staff(actor);
    return db.prepare(`SELECT c.*, (SELECT count(*) FROM palitra_crm_inquiries i WHERE i.customer_id=c.id) inquiries,
        (SELECT count(*) FROM palitra_crm_orders o WHERE o.customer_id=c.id) orders,
        (SELECT max(i.activity_at) FROM palitra_crm_inquiries i WHERE i.customer_id=c.id) activity
      FROM palitra_crm_customers c WHERE c.company_code=? ORDER BY activity DESC LIMIT 500`).all(COMPANY)
      .map((c) => ({ id: c.id, name: c.name, channel: c.channel, channelLabel: CHANNEL_LABELS[c.channel] || c.channel, contact: c.contact,
        inquiryCount: c.inquiries, orderCount: c.orders, activityAt: c.activity }));
  }
  function customer(id, actor) {
    staff(actor);
    const c = q.customer.get(COMPANY, Number(id));
    if (!c) fail(404, 'Клиент не найден');
    const inquiries = db.prepare('SELECT * FROM palitra_crm_inquiries WHERE company_code=? AND customer_id=? ORDER BY id DESC').all(COMPANY, c.id).map((r) => inquiryView(r, actor));
    const orders = db.prepare('SELECT * FROM palitra_crm_orders WHERE company_code=? AND customer_id=? ORDER BY id DESC').all(COMPANY, c.id).map((r) => orderView(r, actor));
    const sameName = c.name ? db.prepare("SELECT count(*) n FROM palitra_crm_customers WHERE company_code=? AND id<>? AND lower(name)=lower(?) AND name<>''").get(COMPANY, c.id, c.name).n : 0;
    return { customer: { ...customerBrief(c.id), createdAt: c.created_at, sameNameCount: sameName }, inquiries, orders };
  }
  function inquiry(id, actor) { staff(actor); return { inquiry: inquiryView(inquiryRow(id), actor, { detail: true }) }; }
  function order(id, actor) { return { order: orderView(orderRow(id, actor), actor, { detail: true }) }; }
  function channels() {
    const email = notifier?.availability ? notifier.availability() : 'not_configured';
    return { telegram: external?.telegramConnected ? 'connected' : 'not_connected', instagram: external?.instagramConnected ? 'connected' : 'not_connected',
      calls: 'manual', email, teamTelegram: teamNotifier ? teamNotifier.availability() : 'not_configured' };
  }
  const options = () => ({ intervals: INTERVALS_FOR, fulfillment: FULFILLMENT_LABELS, pickupPoint: PICKUP_POINT, sources: MANUAL_SOURCES,
    sourceChannels: MANUAL_CHANNELS, basis: Object.fromEntries(MANUAL_BASIS.map((k) => [k, BASIS[k]])), today: localDate() });
  function bootstrap(actor) {
    scoped(actor);
    const me = { id: actor.id, name: actor.name, role: actor.role };
    if (!isStaff(actor)) {
      if (actor.role !== 'customer') fail(403, 'Доступ закрыт');
      const requests = actor.principal ? db.prepare(`SELECT id,created_at,status FROM palitra_crm_inquiries WHERE company_code=? AND principal_provider=? AND principal_subject=? AND status='open' ORDER BY id DESC`)
        .all(COMPANY, actor.principal.provider, actor.principal.subject).map((r) => ({ id: r.id, createdAt: r.created_at, status: 'received' })) : [];
      return { mode, actor: me, orders: ordersFor(actor).map((r) => orderView(r, actor)), requests, price: priceItems(), options: options() };
    }
    const inquiries = db.prepare(`SELECT * FROM palitra_crm_inquiries WHERE company_code=? AND (status='open' OR activity_at>=?) ORDER BY activity_at DESC LIMIT 500`)
      .all(COMPANY, new Date(now() - 30 * 86400000).toISOString()).map((r) => inquiryView(r, actor));
    return { mode, actor: me, inquiries, orders: ordersFor(actor).map((r) => orderView(r, actor)), customers: customersList(actor),
      staff: directory(), price: priceItems(), channels: channels(), options: options() };
  }
  function summary(actor) {
    owner(actor);
    const orders = db.prepare('SELECT * FROM palitra_crm_orders WHERE company_code=?').all(COMPANY);
    const inquiries = db.prepare("SELECT * FROM palitra_crm_inquiries WHERE company_code=? AND status='open'").all(COMPANY);
    const today = localDate();
    const bySource = {};
    for (const s of SOURCES) bySource[s] = db.prepare('SELECT count(*) n FROM palitra_crm_inquiries WHERE company_code=? AND source=? AND created_at>=?').get(COMPANY, s, new Date(now() - 30 * 86400000).toISOString()).n;
    return {
      inquiries: { open: inquiries.length, overdue: inquiries.filter((r) => overdue(r, true)).length, unassigned: inquiries.filter((r) => !r.assignee_id).length },
      orders: { active: orders.filter((o) => o.status === 'active').length, today: orders.filter((o) => o.status === 'active' && o.delivery_date === today).length,
        done: orders.filter((o) => o.status === 'done').length, cancelled: orders.filter((o) => o.status === 'cancelled').length,
        overdue: orders.filter((o) => overdue(o, o.status === 'active')).length,
        byStage: Object.fromEntries(STAGES.map((s) => [s, orders.filter((o) => o.status === 'active' && o.stage === s).length])) },
      paidKopecks: orders.reduce((sum, o) => sum + o.paid_kopecks, 0),
      paidCancelledKopecks: orders.filter((o) => o.status === 'cancelled').reduce((sum, o) => sum + o.paid_kopecks, 0),
      bySource30d: bySource, channels: channels(),
      staff: directory()
    };
  }
  const inquiryExists = (id) => Boolean(Number.isSafeInteger(Number(id)) && q.inquiry.get(COMPANY, Number(id)));
  // Основной канал уведомления команды (для резервной почты): задания действующей очереди сайта по этой заявке.
  function primaryJobs(id) {
    const row = q.inquiry.get(COMPANY, Number(id));
    if (!row) return [];
    if (row.site_order_id) {
      return db.prepare(`SELECT status,created_at,claimed_at FROM site_order_outbox WHERE order_id=? AND site=? AND company_code=?
        AND kind='order' AND destination='manager' ORDER BY id DESC`).all(row.site_order_id, SITE, COMPANY).map((j) => ({ ...j }));
    }
    if (teamNotifier && ['manual', 'instagram_hook'].includes(row.origin)) return teamNotifier.jobs(row.id);
    return external?.primaryJobs ? external.primaryJobs(row) : [];
  }
  const PRIMARY_CHANNEL = { site_form: 'site_queue', site_cart: 'site_queue', app_customer: 'site_queue', manual: 'team_telegram',
    instagram_hook: 'team_telegram', telegram_hook: 'telegram_ingest' };
  /** Состояние основного уведомления команды для карточки сотрудника (без получателей и текстов). */
  function primaryView(row) {
    let latest = null;
    try { latest = primaryJobs(row.id)[0] || null; } catch { latest = null; }
    const configured = PRIMARY_CHANNEL[row.origin] !== 'team_telegram' || Boolean(teamNotifier);
    return { channel: PRIMARY_CHANNEL[row.origin], status: latest ? latest.status : configured ? 'not_registered' : 'not_configured',
      ...(PRIMARY_CHANNEL[row.origin] === 'team_telegram' && teamNotifier ? { availability: teamNotifier.status(row.id).availability } : {}) };
  }

  /* ---------- демонстрационные данные ---------- */
  function seed() {
    if (mode !== 'demo') fail(403, 'Примеры отключены в рабочем режиме');
    if (db.prepare('SELECT count(*) n FROM palitra_crm_inquiries').get().n) return;
    const day = (offset) => localDate(now() + offset * 86400000);
    const sys = { ...ACTORS.varvara };
    const site = (f) => {
      const r = submitSite({ requestId: f.requestId, kind: f.items.length ? 'cart' : 'request', name: f.name, contactChannel: 'telegram', contact: f.contact,
        items: f.items, comment: f.comment, consent: true, page: `${origin}/form-preview.html`,
        ...(f.items.length ? { deliveryDate: day(f.day), deliveryAddress: 'Демонстрационный адрес, Подольск', deliveryInterval: '14:00–16:00' } : {}) }, { ip: `fixture-${f.requestId.slice(-2)}` });
      return r;
    };
    const ids = ['3f1c2a10-0000-4000-8000-000000000001', '3f1c2a10-0000-4000-8000-000000000002', '3f1c2a10-0000-4000-8000-000000000003',
      '3f1c2a10-0000-4000-8000-000000000004', '3f1c2a10-0000-4000-8000-000000000005', '3f1c2a10-0000-4000-8000-000000000006',
      '3f1c2a10-0000-4000-8000-000000000007'];
    // Вымышленная Анна — первый клиент: её заказы видит демонстрационный «клиент».
    const anna = site({ requestId: ids[0], name: 'Анна · пример', contact: '@demo_anna', items: [{ id: 'demo-gold', qty: 1 }], comment: 'Нежные шары на выписку в золотых и молочных оттенках', day: 1 });
    const annaOrder = q.order.get(COMPANY, anna.orderId);
    const force = (orderId, fields) => {
      const sets = Object.keys(fields).map((k) => `${k}=?`).join(',');
      db.prepare(`UPDATE palitra_crm_orders SET ${sets},updated_at=? WHERE id=?`).run(...Object.values(fields), at(), orderId);
    };
    force(annaOrder.id, { stage: 'preparing', payment: 'deposit', paid_kopecks: 300000, assignee_id: 'demo-varvara', next_step: 'Собрать набор и прислать фото', due_at: parseDue(day(0)).iso });
    event('order', annaOrder.id, 'Предоплата подтверждена', 'public', 'Варвара');
    event('order', annaOrder.id, 'Заказ готовится', 'public', 'Варвара');
    const done = site({ requestId: ids[1], name: 'Анна · пример', contact: '@demo_anna', items: [{ id: 'demo-bubble', qty: 1 }], comment: 'Надпись: «Счастье рядом»', day: -2 });
    force(done.orderId, { stage: 'done', status: 'done', payment: 'paid', paid_kopecks: 299000 });
    event('order', done.orderId, 'Заказ выполнен', 'public', 'Дарья');
    site({ requestId: ids[2], name: 'Ирина · пример', contact: '@demo_irina', items: [], comment: 'Подарок для мамы, нужна доставка к вечеру. Подскажите варианты?', day: 0 });
    const manual = (body, actor = sys) => createInquiry({ requestId: body.requestId, ...body }, actor);
    manual({ requestId: ids[3], source: 'instagram', name: 'Мария · пример', contactChannel: 'instagram', contact: '@maria.demo',
      summary: 'Сюрприз на день рождения мужа, бюджет около 6 000 ₽', outcome: 'Отправила примеры в Direct, ждём выбор', basis: 'incoming_message',
      assigneeId: 'demo-varvara', nextStep: 'Уточнить выбор и дату', dueAt: day(-1) });
    manual({ requestId: ids[4], source: 'call', contactChannel: 'phone', contact: '+7 900 000-00-01',
      summary: 'Звонок: шары в потолок для выпускного, 30 штук', outcome: 'Перезвонить, когда клиент уточнит цвета', basis: 'incoming_call',
      assigneeId: 'demo-darya', nextStep: 'Перезвонить клиенту', dueAt: `${day(0)}T18:00` });
    manual({ requestId: ids[5], source: 'telegram', name: 'Олег · пример', contactChannel: 'telegram', contact: '@demo_oleg',
      summary: 'Гендер-пати, нужен шар-сюрприз', basis: 'incoming_message', nextStep: 'Назначить ответственного' });
  }

  return { submitSite, attachExisting, createInquiry, recordExternalInquiry, inquiryAction, orderAction, inquiry, order, customer,
    bootstrap, summary, seed, inquiryExists, primaryJobs, legacy, tx, get priceDoc() { return readPrice(); }, priceItems, directory };
}

module.exports = { createWorkspace, ACTORS, STAGES, LABELS, SOURCES, INTERVALS, INTERVALS_FOR, PICKUP_POINT, COMPANY, SITE,
  owner, staff, normalizeContact, fail };
