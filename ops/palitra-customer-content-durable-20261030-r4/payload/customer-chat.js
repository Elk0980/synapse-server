'use strict';

/* Palitra: общий чат клиента (сайт + Telegram) — ядро phaseA, 14.10.2026 (repair FR-010–013).

   Одна история переписки на заявку (chat_threads / chat_thread_messages) в той же центральной SQLite Synapse.
   Клиент пишет в чат сайта без Telegram или — после явного START по одноразовой ссылке — из Telegram; менеджер
   отвечает из приложения владельца или из Telegram. Каждое сообщение — одна запись истории; копии в Telegram
   (менеджеру и клиенту) — отдельные доставки со своими статусами и квитанциями. «Сохранено» ≠ «доставлено» ≠ «прочитано».

   Границы модуля:
   - только новые таблицы chat_* (CREATE … IF NOT EXISTS); старые client_* / site_* не читаются и не меняются,
     foreign_keys не трогаются, legacy-история Telegram в новую историю не копируется;
   - транспорта, токенов бота, HTTP и своего worker здесь нет: задания в существующую очередь кладёт внедрённый
     enqueue(job) внутри той же транзакции; исход приходит через acknowledgeDelivery;
   - доступ гостя — только узкая cookie чата (__Host-PalitraChat, 30 дней) + CSRF + точный Origin + сайт, проверяются
     при каждом вызове; номер заявки, requestId, телефон, @ник и IP доступа не дают;
   - ответ владельца — только при ownerStillValid(userId, sessionVersion) === true (до и внутри транзакции);
   - сырые секреты (cookie) не попадают ни в JSON, ни в историю, ни в журнал: в базе только sha256.
   Все данные запросов и Telegram — недоверенные.

   PALITRA-WEBCHAT-PHASED1 (14.10.2026):
   - все восемь native видов Telegram (photo/voice/audio/video/video_note/animation/document/sticker) от клиента и в ответе
     менеджера — одна canonical запись истории (caption — её текст, может быть пустым) и одно typed-вложение
     chat_thread_attachments (`thread:<id>`, отдельное от legacy); байты — одна приватная копия, скачивает существующий мост;
   - копии в Telegram — существующая очередь: менеджеру [короткая шапка, copyMessage настоящего источника], клиенту
     copyMessage ответа менеджера; источник — только сохранённое проверенное сообщение того же бота;
   - правка media-сообщения в Telegram — отдельное canonical событие (chat_thread_media_events) со ссылкой на исходное;
     прежняя версия и её файл остаются, неотправленная копия прежней версии не выдаётся;
   - копия своего сообщения с сайта клиенту в Telegram (mirrorCustomerWebToTelegram) подписана «Вы написали на сайте»;
   - файлы читаются только по доступу: покупатель — cookie чата + доступ к чату (CSRF не нужен лишь этому чтению),
     владелец — ownerStillValid; file_id, путь на диске и хеш наружу не выдаются.

   PALITRA-WEBCHAT-PHASEE (14.10.2026): один файл с сайта (покупатель) и из приложения (владелец) — настоящая запись этой
   же истории + журнал chat_web_uploads (customer-chat-upload.cjs) + прежняя квитанция chat_thread_requests + прежние
   доставки/задания очереди. requestId файла и текста — одно пространство автора. Копии — sendPhoto/sendDocument тем же
   мостом (байты по фиксированному внутреннему маршруту), без copyMessage и поддельных номеров Telegram; без Telegram
   файл и сообщение всё равно сохранены в чате. Новые загрузки — только при включённом webUploadsEnabled (по умолчанию нет). */

const crypto = require('node:crypto');
const mediaKit = require('./customer-chat-media.cjs');
const uploadKit = require('./customer-chat-upload.cjs');
const fs = require('node:fs');

const SCOPE = 'customer_chat';
const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY;
const LINK_TTL = 30 * 60 * 1000;
const MAX_TEXT = 4000;                 // сайт и приложение владельца
const MAX_TELEGRAM_TEXT = 4096;        // входящее из Telegram (предел самого Telegram) — без молчаливого обрезания
const PAGE = Object.freeze({ default: 50, max: 100 });
const WEB_RATE = Object.freeze({ windowMs: 10 * 60 * 1000, perWindow: 20, perDay: 200 });
const LINK_RATE = Object.freeze({ windowMs: 60 * 60 * 1000, max: 5 });
const COOKIE = Object.freeze({ secure: '__Host-PalitraChat', local: 'PalitraChatLocal' });
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// FR-010: users.id аккаунта магазина (AccountService) — TEXT UUID; это не числовой id владельца Synapse.
const ACCOUNT_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;                    // 32 случайных байта base64url
const LINK_PAYLOAD = /^c_([A-Za-z0-9_-]{32})$/;         // 24 случайных байта; start-параметр Telegram ≤ 64 символов
const TELEGRAM_ID = /^[1-9]\d{0,19}$/;
const TELEGRAM_MESSAGE_ID = /^[1-9]\d{0,15}$/;          // номер сообщения Telegram — положительное безопасное целое
const BOT_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const JOB_REF = /^[\x21-\x7e]{1,120}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const CONTROL_ALL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[1-9]\d{0,4})?$/;
const UNDELIVERED = Object.freeze(['not_queued', 'failed', 'uncertain']);
const NO_RECEIPT = 'Мост сообщил об успехе без номера сообщения Telegram — доставка не подтверждена';
// PHASED1: подпись копии собственного сообщения клиента с сайта (только эта копия; ответы магазина — исходный текст).
const SELF_WEB_LABEL = 'Вы написали на сайте:';
const FILE_ID = /^[\x21-\x7e]{1,300}$/;
const MEDIA_MIME = /^[a-z]+\/[a-z0-9.+-]{1,80}$/;
const GROUP_ID = /^[0-9A-Za-z_-]{1,64}$/;
const KIND_LABEL = Object.freeze({ photo: 'фото', voice: 'голосовое', audio: 'аудио', video: 'видео', video_note: 'видеосообщение',
  animation: 'анимация', document: 'файл', sticker: 'стикер' });

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const oneLine = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const positiveId = (value) => {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const telegramId = (value) => { const text = String(value ?? ''); return TELEGRAM_ID.test(text) ? text : ''; };
/* Номера сообщений из квитанции моста: только положительные безопасные целые, без повторов, не больше 20. */
const receiptIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((id) => (typeof id === 'number' ? String(id) : typeof id === 'string' ? id : ''))
  .filter((id) => TELEGRAM_MESSAGE_ID.test(id) && Number.isSafeInteger(Number(id))))].slice(0, 20);
const csrfOf = (token) => crypto.createHmac('sha256', token).update('palitra-chat-csrf-v1').digest('base64url');

/* Точный origin из настройки: https без порта, пути, учётных данных и *; http://localhost — только при allowLocalHttp. */
function exactOrigin(raw, allowLocalHttp) {
  if (typeof raw !== 'string') return null;
  if (allowLocalHttp && LOCAL_ORIGIN.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  if (url.origin !== raw || url.protocol !== 'https:' || url.username || url.password || url.port || raw.includes('*')) return null;
  return raw;
}
/* Единственное значение cookie чата из заголовка Cookie; несколько одноимённых значений — отказ (неоднозначно). */
function readToken(header, name) {
  const values = String(header || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && TOKEN.test(values[0]) ? values[0] : null;
}
function cookieString(name, value, maxAgeSeconds) {
  const secure = name === COOKIE.secure ? '; Secure' : '';
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/${secure}; HttpOnly; SameSite=Strict`;
}
function exactKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== [...keys].sort().join(',')) {
    fail(400, `Нужны только поля: ${keys.join(', ')}`, 'VALIDATION');
  }
  return body;
}
/* Текст с сайта и из приложения: без молчаливого обрезания и вычищения — явный отказ. */
function textOf(value, max) {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'Напишите текст сообщения', 'EMPTY');
  if (value.length > max) fail(400, `Сообщение длиннее ${max} символов — сократите его`, 'TOO_LONG');
  if (CONTROL.test(value)) fail(400, 'В тексте есть служебные символы', 'VALIDATION');
  return value;
}
// Контакт заявлен самим посетителем. Номер не подтверждает личность и не даёт доступ к переписке.
function widgetPhoneOf(value) {
  if (typeof value !== 'string' || value.length > 32 || !/^\+?[0-9\s().-]+$/.test(value)) {
    fail(400, 'Укажите номер с кодом страны', 'PHONE');
  }
  const digits = value.replace(/\D/g, '');
  if (value.startsWith('+') && /^[1-9]\d{9,14}$/.test(digits)) return `+${digits}`;
  if (!value.startsWith('+') && /^8\d{10}$/.test(digits)) return `+7${digits.slice(1)}`;
  if (!value.startsWith('+') && /^7\d{10}$/.test(digits)) return `+${digits}`;
  if (!value.startsWith('+') && /^\d{10}$/.test(digits)) return `+7${digits}`;
  fail(400, 'Укажите номер с кодом страны: + и 10–15 цифр', 'PHONE');
}
const widgetPhoneMessage = phone => `Мой номер телефона: ${phone}`;
/* Входящий текст Telegram: служебные символы вычищаются (сообщение уже отправлено клиентом и не должно потеряться);
   без текста (фото, стикер и т. п.) — null: вызывающий решает, что ответить. */
function telegramTextOf(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_ALL, '');
  if (!text.trim()) return null;
  if (text.length > MAX_TELEGRAM_TEXT) fail(400, `Сообщение длиннее ${MAX_TELEGRAM_TEXT} символов`, 'TOO_LONG');
  return text;
}
function requestIdOf(value) {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  if (!REQUEST_ID.test(id)) fail(400, 'Некорректный requestId', 'VALIDATION');
  return id;
}
function limitOf(value) {
  if (value === undefined || value === null || value === '') return PAGE.default;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE.max) fail(400, `Параметр limit — целое от 1 до ${PAGE.max}`, 'VALIDATION');
  return n;
}
function cursorOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = positiveId(value);
  if (!n) fail(400, 'Некорректный курсор before', 'VALIDATION');
  return n;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS chat_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, company_code TEXT NOT NULL, order_id INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT
  );
  -- Одна заявка — не больше одного чата: повтор заявки не создаёт второй чат.
  CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_order ON chat_threads(site, order_id) WHERE order_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS chat_threads_recent ON chat_threads(site, company_code, id);
  -- account_user_id — TEXT UUID аккаунта магазина (только аудит, не доступ); у гостя NULL.
  CREATE TABLE IF NOT EXISTS chat_web_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
    site TEXT NOT NULL, company_code TEXT NOT NULL, origin TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope = 'customer_chat'),
    account_kind TEXT NOT NULL CHECK(account_kind IN ('guest','user')), account_user_id TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
    CHECK((account_kind = 'guest' AND account_user_id IS NULL) OR (account_kind = 'user' AND length(account_user_id) = 36))
  );
  CREATE TABLE IF NOT EXISTS chat_web_grants (
    session_id INTEGER NOT NULL REFERENCES chat_web_sessions(id), thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
    created_at TEXT NOT NULL, PRIMARY KEY(session_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS chat_widget_starts (
    session_id INTEGER NOT NULL REFERENCES chat_web_sessions(id), request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('text','phone','upload')), fingerprint TEXT NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id), message_id INTEGER REFERENCES chat_thread_messages(id),
    upload_uuid TEXT, created_at TEXT NOT NULL, PRIMARY KEY(session_id,request_id)
  );
  CREATE TABLE IF NOT EXISTS chat_thread_contacts (
    thread_id INTEGER PRIMARY KEY REFERENCES chat_threads(id), session_id INTEGER NOT NULL REFERENCES chat_web_sessions(id),
    phone TEXT NOT NULL, message_id INTEGER NOT NULL REFERENCES chat_thread_messages(id), provided_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_thread_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
    bot_key TEXT NOT NULL, telegram_user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','inactive')), verified_at TEXT NOT NULL,
    deactivated_at TEXT, deactivated_reason TEXT NOT NULL DEFAULT ''
  );
  -- Telegram-пользователь бота активен ровно в одном чате; у чата — не больше одного активного Telegram.
  CREATE UNIQUE INDEX IF NOT EXISTS chat_thread_channels_user ON chat_thread_channels(bot_key, telegram_user_id) WHERE status = 'active';
  CREATE UNIQUE INDEX IF NOT EXISTS chat_thread_channels_thread ON chat_thread_channels(thread_id) WHERE status = 'active';
  CREATE TABLE IF NOT EXISTS chat_thread_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
    session_id INTEGER NOT NULL REFERENCES chat_web_sessions(id), bot_key TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT
  );
  CREATE INDEX IF NOT EXISTS chat_thread_links_session ON chat_thread_links(session_id, created_at);
  CREATE TABLE IF NOT EXISTS chat_thread_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
    direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    author_kind TEXT NOT NULL CHECK(author_kind IN ('customer','owner','manager')),
    source_channel TEXT NOT NULL CHECK(source_channel IN ('web','telegram','app','manager_telegram')),
    text TEXT NOT NULL, created_at TEXT NOT NULL,
    web_status TEXT NOT NULL DEFAULT 'stored' CHECK(web_status = 'stored'),
    web_session_id INTEGER REFERENCES chat_web_sessions(id), owner_user_id INTEGER,
    bot_key TEXT, tg_chat_id TEXT, tg_message_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS chat_thread_messages_thread ON chat_thread_messages(thread_id, id);
  CREATE INDEX IF NOT EXISTS chat_thread_messages_session ON chat_thread_messages(web_session_id, created_at);
  -- Входящее из Telegram (клиент или менеджер) — одна запись на bot/chat/message_id.
  CREATE UNIQUE INDEX IF NOT EXISTS chat_thread_messages_tg ON chat_thread_messages(bot_key, tg_chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS chat_message_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_thread_messages(id),
    channel TEXT NOT NULL CHECK(channel IN ('manager_telegram','customer_telegram')),
    status TEXT NOT NULL CHECK(status IN ('queued','not_queued','sent','failed','uncertain')),
    job_ref TEXT UNIQUE, reason TEXT NOT NULL DEFAULT '', receipt TEXT NOT NULL DEFAULT '[]',
    bot_key TEXT, target_chat_id TEXT, channel_id INTEGER REFERENCES chat_thread_channels(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(message_id, channel)
  );
  CREATE INDEX IF NOT EXISTS chat_message_deliveries_status ON chat_message_deliveries(status, id);
  CREATE TABLE IF NOT EXISTS chat_thread_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('web','owner')),
    actor_ref TEXT NOT NULL, actor_session_version INTEGER, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id), message_id INTEGER NOT NULL REFERENCES chat_thread_messages(id),
    created_at TEXT NOT NULL, UNIQUE(actor_kind, actor_ref, request_id), UNIQUE(message_id)
  );
  -- Копии у менеджера в Telegram (по квитанции моста): ответ менеджера «Ответить» маршрутизируется только по этой карте.
  CREATE TABLE IF NOT EXISTS chat_manager_map (
    bot_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id), chat_message_id INTEGER NOT NULL REFERENCES chat_thread_messages(id),
    created_at TEXT NOT NULL, PRIMARY KEY(bot_key, chat_id, message_id)
  );
`;
/* PHASED1: только новые таблицы chat_* (CREATE … IF NOT EXISTS), прежние таблицы, индексы и строки не меняются.
   Вложение — своё положительное id (`thread:<id>`), отдельно от legacy client_dialog_attachments. file_id/disk_name/sha256
   — только для сервера и моста. Событие правки — отдельная canonical запись; уникальность по настоящим полям Telegram. */
const MEDIA_DDL = `
  CREATE TABLE IF NOT EXISTS chat_thread_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES chat_thread_messages(id), thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
    site TEXT NOT NULL, company_code TEXT NOT NULL, bot_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('photo','voice','audio','video','video_note','animation','document','sticker')),
    mime TEXT NOT NULL, name TEXT NOT NULL, expected_size INTEGER,
    file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL DEFAULT '', flags TEXT NOT NULL DEFAULT '{}',
    source_chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','stored','too_large','unavailable','quota_exceeded')),
    disk_name TEXT NOT NULL UNIQUE, sha256 TEXT, actual_size INTEGER, content_type TEXT, presentation TEXT,
    error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stored_at TEXT
  );
  CREATE INDEX IF NOT EXISTS chat_thread_attachments_message ON chat_thread_attachments(message_id, id);
  CREATE INDEX IF NOT EXISTS chat_thread_attachments_status ON chat_thread_attachments(bot_key, status, id);
  CREATE TABLE IF NOT EXISTS chat_thread_media_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE REFERENCES chat_thread_messages(id),
    replaces_message_id INTEGER NOT NULL REFERENCES chat_thread_messages(id),
    bot_key TEXT NOT NULL, tg_chat_id TEXT NOT NULL, tg_message_id INTEGER NOT NULL, edit_date INTEGER NOT NULL,
    fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(bot_key, tg_chat_id, tg_message_id, edit_date)
  );
  CREATE INDEX IF NOT EXISTS chat_thread_media_events_original ON chat_thread_media_events(replaces_message_id, id);
`;

/* Транзакция по умолчанию: BEGIN IMMEDIATE снаружи, SAVEPOINT внутри уже открытой (в том числе чужой) транзакции.
   В phaseB host передаёт свой transact — тот же, что у заявки, чтобы заявка и чат были одной транзакцией. */
function defaultTransact(db) {
  let depth = 0;
  return (fn) => {
    const nested = depth > 0 || db.isTransaction === true;
    const name = `customer_chat_${depth}`;
    db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    depth += 1;
    try {
      const value = fn();
      db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return value;
    } catch (error) {
      if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); } else db.exec('ROLLBACK');
      throw error;
    } finally { depth -= 1; }
  };
}

function createCustomerChat(options = {}) {
  const { db, transact, now = Date.now, randomBytes = crypto.randomBytes, sites = {}, allowLocalHttp = false,
    botForSite = () => null, activeOperator = () => null, bridgeReady = () => false, ownerStillValid = null,
    enqueue = null, orderExists = null, mirrorCustomerWebToTelegram = false, media = null,
    // PHASEE: журнал загрузок (создаёт адаптер после таблиц ядра), выключатель новых загрузок и пространство requestId
    // ответов владельца в прежние диалоги (client_dialog_owner_requests читает только адаптер/client-dialogs).
    webUploads = null, webUploadsEnabled = null, ownerLegacyRequestUsed = null, ownerCanRead = null, onCustomerMessage = null, onOrderThreadCreated = null, onMessageStored = null, customerQuestions = null, automaticReplyView = null, ownerAdvisories = null, customerOrderLifecycle = null, customerContactPrefill = null, readCompletionMedia = null, attribution = null } = options;
  /* PHASED1: хранилище и общие пределы файлов. storage — createMediaStorage приватного каталога; legacyBytes — уже
     сохранённые байты прежних диалогов (общий предел maxStorage один на всех). Без media вложения записываются,
     но сохранить байты нельзя (503) — текстовый путь от этого не зависит. */
  const mediaStorage = media && media.storage ? media.storage : null;
  const maxFile = media && Number.isSafeInteger(media.maxFile) && media.maxFile > 0 ? media.maxFile : mediaKit.DEFAULT_MAX_FILE;
  const maxStorage = media && Number.isSafeInteger(media.maxStorage) && media.maxStorage >= 0 ? media.maxStorage : mediaKit.DEFAULT_MAX_STORAGE;
  const legacyBytes = () => { try { const n = media && typeof media.legacyBytes === 'function' ? Number(media.legacyBytes()) : 0; return Number.isFinite(n) && n > 0 ? n : 0; } catch (_) { return 0; } };
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw new TypeError('createCustomerChat: нужен db (node:sqlite DatabaseSync)');
  const config = new Map();
  for (const [site, entry] of Object.entries(sites || {})) {
    const companyCode = entry && typeof entry.companyCode === 'string' ? entry.companyCode : '';
    const origins = Array.isArray(entry && entry.origins) ? entry.origins.map((origin) => exactOrigin(origin, allowLocalHttp)) : [];
    if (!/^[a-z0-9-]{1,40}$/.test(site) || !/^[a-z0-9-]{1,64}$/.test(companyCode) || !origins.length || origins.some((origin) => !origin)) {
      throw new TypeError(`createCustomerChat: неверная настройка сайта ${site}`);
    }
    config.set(site, Object.freeze({ site, companyCode, origins: Object.freeze([...origins]) }));
  }
  const tx = typeof transact === 'function' ? transact : defaultTransact(db);
  db.exec(DDL);
  db.exec(MEDIA_DDL);
  const stamp = (at = now()) => new Date(at).toISOString();
  const siteOf = (site) => config.get(site) || fail(404, 'Чат недоступен', 'SITE');
  const cookieName = (origin) => (allowLocalHttp && LOCAL_ORIGIN.test(origin) ? COOKIE.local : COOKIE.secure);

  /* ---------- внедрённые зависимости: любой сбой — «не готово», не исключение наружу ---------- */
  const botOf = (site) => {
    try { const found = botForSite(site); return found && found.enabled === true && BOT_KEY.test(String(found.key || '')) ? String(found.key) : null; }
    catch (_) { return null; }
  };
  const operatorOf = (botKey) => {
    try { const op = activeOperator(botKey); return op ? telegramId(op.telegramUserId ?? op.telegram_user_id) || null : null; }
    catch (_) { return null; }
  };
  const ready = (botKey) => { try { return bridgeReady(botKey) === true; } catch (_) { return false; } };
  function ownerValid(id, version) {
    if (typeof ownerStillValid !== 'function') return false;
    try { return ownerStillValid(id, version) === true; } catch (_) { return false; }
  }
  function requireOwner(owner) {
    if (typeof ownerStillValid !== 'function') fail(503, 'Проверка владельца не подключена', 'OWNER_CHECK_MISSING');
    const id = owner && owner.id, version = owner && owner.sessionVersion;
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(version)) fail(403, 'Нет доступа', 'OWNER');
    if (!ownerValid(id, version)) fail(403, 'Доступ владельца изменился', 'OWNER_REVOKED');
    return Object.freeze({ id, sessionVersion: version });
  }
  function requireReader(owner) {
    if (!ownerCanRead) return requireOwner(owner);
    const id = owner?.id, version = owner?.sessionVersion;
    let valid = false;
    try { valid = Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(version) && ownerCanRead(id, version) === true; } catch (_) {}
    if (!valid) fail(403, 'Доступ к переписке изменился', 'READER_REVOKED');
    return Object.freeze({ id, sessionVersion: version });
  }
  function callEnqueue(job) {
    const ref = enqueue(Object.freeze(job));
    if (typeof ref !== 'string' || !JOB_REF.test(ref)) fail(500, 'Очередь не вернула номер задания', 'ENQUEUE');
    return ref;
  }
  // PHASEE: журнал загрузок и выключатель; любой сбой зависимости — «нет загрузок», текстовый путь не затронут.
  const uploadStore = () => { try { return typeof webUploads === 'function' ? webUploads() || null : null; } catch (_) { return null; } };
  const uploadsOn = () => { try { return typeof webUploadsEnabled === 'function' && webUploadsEnabled() === true && Boolean(uploadStore()); } catch (_) { return false; } };
  function requireUploads({ write = true } = {}) {
    const store = uploadStore();
    if (!store) fail(404, 'Не найдено', 'NOT_FOUND');
    if (write && !uploadsOn()) fail(409, 'Отправка файлов пока недоступна — напишите текстом', 'UPLOADS_DISABLED');
    return store;
  }
  const uploadOfMessage = (messageId) => { const store = uploadStore(); return store ? store.forThreadMessage(messageId) : null; };
  // Одно пространство requestId текста и файла: текстовая квитанция с этим requestId — у файла 409, и наоборот.
  const textRequestUsed = (kind, actorRef, requestId) => Boolean(db.prepare('SELECT 1 FROM chat_thread_requests WHERE actor_kind=? AND actor_ref=? AND request_id=?')
    .get(kind, actorRef, String(requestId || '').toLowerCase()));
  function fileRequestConflict(kind, actorRef, requestId) {
    const store = uploadStore();
    if (store && store.requestUsed(kind, actorRef, requestId)) fail(409, 'Этот requestId уже использован для отправки файла', 'REQUEST_MISMATCH');
  }
  const uploadsInfo = () => (uploadsOn() ? { uploads: { enabled: true, maxBytes: uploadStore().maxFile } } : {});

  /* ---------- веб-сессия гостя ---------- */
  function resolve(request, { csrf = true } = {}) {
    const r = request && typeof request === 'object' ? request : {};
    const cfg = siteOf(r.site);
    if (typeof r.origin !== 'string' || !cfg.origins.includes(r.origin)) fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
    const token = readToken(r.cookie, cookieName(r.origin));
    if (!token) fail(401, 'Сессия чата не найдена', 'NO_SESSION');
    const row = db.prepare('SELECT * FROM chat_web_sessions WHERE token_hash=?').get(sha256(token));
    // Сессия привязана к сайту, компании и точному адресу, на котором создана.
    if (!row || row.scope !== SCOPE || row.site !== cfg.site || row.company_code !== cfg.companyCode || row.origin !== r.origin
      || !safeEqual(row.csrf_hash, sha256(csrfOf(token)))) fail(401, 'Сессия чата не найдена', 'NO_SESSION');
    if (row.revoked_at) fail(401, 'Сессия чата закрыта', 'REVOKED');
    if (!(Date.parse(row.expires_at) > now())) fail(401, 'Сессия чата истекла', 'EXPIRED');
    if (csrf && (typeof r.csrf !== 'string' || !safeEqual(r.csrf, csrfOf(token)))) fail(403, 'Неверный токен запроса', 'CSRF');
    return { session: row, cfg, token };
  }
  /* FR-010: подтверждение аккаунта приходит только от host (AccountService.current по cookie магазина).
     Зарегистрированный покупатель — { kind:'user', userId:'<UUID users.id>' }; неверный id — отказ, а не понижение до гостя.
     Числовой id владельца Synapse сюда не принимается: это другой контракт (ownerStillValid). */
  function accountOf(account) {
    if (!account || typeof account !== 'object') fail(500, 'Нет подтверждения аккаунта от хоста', 'ACCOUNT_PROOF');
    if (account.kind === 'guest' && (account.userId === undefined || account.userId === null)) return { kind: 'guest', userId: null };
    if (account.kind === 'user' && typeof account.userId === 'string') {
      const id = account.userId.toLowerCase();
      if (ACCOUNT_USER_ID.test(id)) return { kind: 'user', userId: id };
    }
    return fail(500, 'Неверное подтверждение аккаунта от хоста', 'ACCOUNT_PROOF');
  }
  /* Сессия создаётся без чатов и сообщений. Действующая cookie — та же сессия и её CSRF; иначе новая.
     setCookie (сырой секрет) — только для заголовка Set-Cookie, не для JSON. */
  function ensureWebSession(request, { account } = {}) {
    const r = request && typeof request === 'object' ? request : {};
    const cfg = siteOf(r.site);
    if (typeof r.origin !== 'string' || !cfg.origins.includes(r.origin)) fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
    try {
      const { session, token } = resolve(r, { csrf: false });
      return { created: false, csrfToken: csrfOf(token), expiresAt: session.expires_at, setCookie: null };
    } catch (error) { if (error.status !== 401) throw error; }
    const proof = accountOf(account);
    const token = randomBytes(32).toString('base64url');
    if (!TOKEN.test(token)) fail(500, 'Не удалось создать сессию чата', 'RANDOM');
    const at = now(), expiresAt = stamp(at + SESSION_TTL);
    tx(() => db.prepare(`INSERT INTO chat_web_sessions(token_hash,csrf_hash,site,company_code,origin,scope,account_kind,account_user_id,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(sha256(token), sha256(csrfOf(token)), cfg.site, cfg.companyCode, r.origin, SCOPE, proof.kind, proof.userId, stamp(at), expiresAt));
    return { created: true, csrfToken: csrfOf(token), expiresAt, setCookie: cookieString(cookieName(r.origin), token, SESSION_TTL / 1000) };
  }
  function revokeWebSession(request) {
    const { session } = resolve(request);
    tx(() => db.prepare('UPDATE chat_web_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(stamp(), session.id));
    return { ok: true, setCookie: cookieString(cookieName(session.origin), '', 0) };
  }

  /* ---------- представления: без секретов, хешей и внутренних номеров сессий ---------- */
  const threadRow = (id) => db.prepare('SELECT * FROM chat_threads WHERE id=?').get(id);
  const messageRow = (id) => db.prepare('SELECT * FROM chat_thread_messages WHERE id=?').get(id);
  const activeChannel = (threadId) => db.prepare("SELECT * FROM chat_thread_channels WHERE thread_id=? AND status='active'").get(threadId) || null;
  function threadView(row) {
    return { id: row.id, orderId: row.order_id ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at || null, telegramLinked: Boolean(activeChannel(row.id)) };
  }
  function contactRequest(thread) {
    // The prompt and staff contact card describe the same granted thread, not a different order's chat.
    const provided = Boolean(db.prepare('SELECT 1 FROM chat_thread_contacts WHERE thread_id=?').get(thread.id));
    return { needed: !provided, provided };
  }
  function webContactRequest(request, session, thread) {
    const base = contactRequest(thread);
    if (base.provided || thread.site !== 'palitra' || thread.company_code !== 'palitra-love' || !positiveId(thread.order_id)
      || typeof customerContactPrefill !== 'function') return base;
    let prefill = null;
    try {
      const value = customerContactPrefill(Object.freeze({ ...thread }));
      if (value && value.threadId === thread.id && value.orderId === thread.order_id && typeof value.name === 'string'
        && value.name.length <= 100 && !CONTROL.test(value.name)) {
        prefill = { source: 'accepted-order', threadId: thread.id, orderId: thread.order_id, name: value.name.trim(), phone: widgetPhoneOf(value.phone) };
      }
    } catch (_) { /* Optional suggestion failure must not hide the existing conversation or request. */ }
    // The callback never grants access. Recheck the real cookie/grant/FK after reading its suggestion.
    const fresh = resolve(request);
    if (fresh.session.id !== session.id) fail(403, 'Доступ к переписке изменился', 'SESSION');
    const current = grantedThread(fresh.session, fresh.cfg, thread.id);
    if (current.order_id !== thread.order_id) fail(409, 'Связь чата и заявки изменилась. Обновите переписку.', 'CONTACT_PREFILL_SCOPE_CHANGED');
    const currentBase = contactRequest(current);
    return prefill && !currentBase.provided ? { ...currentBase, prefill } : currentBase;
  }
  function customerContact(thread) {
    const row = db.prepare('SELECT phone,provided_at FROM chat_thread_contacts WHERE thread_id=?').get(thread.id);
    return row ? { phone: row.phone, providedAt: row.provided_at } : null;
  }
  /* PHASED1: публичные сведения о вложении — ссылка thread:<id>, вид, проверенный тип, имя, размер, состояние хранения,
     способ показа. Ни file_id, ни имени на диске, ни хеша, ни путей. Добавляются к сообщению только если вложения есть,
     как и сведения о версии (событие правки / есть новая версия): текстовые сообщения выглядят как раньше. */
  const attachmentRows = (messageId) => db.prepare('SELECT * FROM chat_thread_attachments WHERE message_id=? ORDER BY id').all(messageId);
  const flagsOf = (row) => { try { const flags = JSON.parse(row.flags || '{}'); return flags && typeof flags === 'object' ? flags : {}; } catch (_) { return {}; } };
  function attachmentView(row) {
    const flags = flagsOf(row);
    return { ref: mediaKit.typedRef(row.id), kind: row.kind, mime: row.status === 'stored' ? (row.content_type || 'application/octet-stream') : row.mime,
      name: mediaKit.downloadName(row.name, row.kind, row.content_type), size: row.actual_size ?? row.expected_size ?? null, storageStatus: row.status,
      error: row.status === 'stored' || row.status === 'pending' ? '' : row.error, presentation: row.status === 'stored' ? (row.presentation || 'download') : 'none',
      ...(row.kind === 'sticker' ? { animated: flags.animated === true, videoSticker: flags.video === true } : {}) };
  }
  const eventOf = (messageId) => db.prepare('SELECT * FROM chat_thread_media_events WHERE message_id=?').get(messageId) || null;
  const editedLater = (messageId) => Boolean(db.prepare('SELECT 1 FROM chat_thread_media_events WHERE replaces_message_id=? LIMIT 1').get(messageId));
  function mediaFields(row) {
    // PHASEE: файл с сайта или из приложения — то же поле attachments (ref `upload:<UUID>`), прежние вложения не меняются.
    const upload = uploadOfMessage(row.id);
    const files = [...attachmentRows(row.id).map(attachmentView), ...(upload ? [uploadStore().attachmentView(upload)] : [])];
    const event = eventOf(row.id);
    return { ...(files.length ? { attachments: files } : {}), ...(event ? { replacesMessageId: event.replaces_message_id } : {}),
      ...(editedLater(row.id) ? { edited: true } : {}) };
  }
  function automaticReplyFields(row) {
    if (typeof automaticReplyView !== 'function' || row.direction !== 'out' || row.author_kind !== 'manager' || row.source_channel !== 'app') return {};
    let value;
    try { value = automaticReplyView(Object.freeze({ id: row.id, thread_id: row.thread_id, direction: row.direction, author_kind: row.author_kind, source_channel: row.source_channel })); }
    catch (_) { return {}; } // Optional display metadata must not hide the retained original history.
    if (!value || value.automaticReplyKind !== 'order-received' || typeof value.displayText !== 'string' || !value.displayText.trim() || value.displayText.length > 1000) return {};
    return { automaticReplyKind: 'order-received', displayText: value.displayText };
  }
  const customerMessageView = (row) => ({ id: row.id, direction: row.direction, author: row.author_kind === 'customer' ? 'customer' : 'shop',
    channel: row.source_channel === 'telegram' ? 'telegram' : row.source_channel === 'web' ? 'web' : 'shop', text: row.text, createdAt: row.created_at, stored: true,
    ...mediaFields(row), ...automaticReplyFields(row) });
  function deliveriesOf(messageId) {
    return db.prepare('SELECT channel,status,reason,receipt,updated_at FROM chat_message_deliveries WHERE message_id=? ORDER BY id').all(messageId)
      .map((d) => ({ channel: d.channel, status: d.status, reason: d.reason, receiptCount: JSON.parse(d.receipt || '[]').length, updatedAt: d.updated_at }));
  }
  const ownerMessageView = (row) => ({ id: row.id, direction: row.direction, author: row.author_kind, source: row.source_channel,
    text: row.text, createdAt: row.created_at, web: 'stored', deliveries: deliveriesOf(row.id), ...mediaFields(row), ...automaticReplyFields(row) });
  function page(rows, limit) {
    const more = rows.length > limit;
    const list = rows.slice(0, limit);
    return { list, nextBefore: more ? list[list.length - 1].id : null };
  }
  function messagesPage(threadId, before, limit, view) {
    const rows = db.prepare('SELECT * FROM chat_thread_messages WHERE thread_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?')
      .all(threadId, before, before, limit + 1);
    const { list, nextBefore } = page(rows, limit);
    return { messages: list.reverse().map(view), nextBefore };
  }

  // Общая лента — только прямые grants одной сессии, без перехода через другие сессии.
  // LIMIT применяется к глобальным message.id в SQL, а не к предварительному списку чатов.
  function conversationPage(seed, sessionId, before, limit, view) {
    const predicate = sessionId === null ? 't.id=?'
      : 'EXISTS (SELECT 1 FROM chat_web_grants g WHERE g.thread_id=t.id AND g.session_id=?)';
    const rows = db.prepare(`SELECT m.*,t.order_id AS conversation_order_id FROM chat_thread_messages m
      JOIN chat_threads t ON t.id=m.thread_id WHERE t.site=? AND t.company_code=? AND ${predicate}
      AND (? IS NULL OR m.id<?) ORDER BY m.id DESC LIMIT ?`)
      .all(seed.site, seed.company_code, sessionId === null ? seed.id : sessionId, before, before, limit + 1);
    const { list, nextBefore } = page(rows, limit);
    return { messages: list.reverse().map(row => ({ ...view(row), threadId: row.thread_id, orderId: row.conversation_order_id ?? null })), nextBefore };
  }
  function conversationScopeKey(seed, sessionId) {
    const hash = crypto.createHash('sha256').update(JSON.stringify(['conversation-v1', seed.site, seed.company_code]));
    if (sessionId === null) hash.update(`\n${seed.id}`);
    else {
      const ids = db.prepare(`SELECT t.id FROM chat_threads t WHERE t.site=? AND t.company_code=?
        AND EXISTS (SELECT 1 FROM chat_web_grants g WHERE g.thread_id=t.id AND g.session_id=?) ORDER BY t.id`)
        .iterate(seed.site, seed.company_code, sessionId);
      for (const row of ids) hash.update(`\n${row.id}`);
    }
    return hash.digest('hex');
  }
  function staffConversationSession(seed) {
    const grants = db.prepare('SELECT session_id FROM chat_web_grants WHERE thread_id=? ORDER BY session_id LIMIT 2').all(seed.id);
    return grants.length === 1 ? grants[0].session_id : null;
  }
  function conversationView(seed, sessionId, cursor, size, view) {
    const thread = threadView(seed);
    return { thread, seedThread: { ...thread }, composeThread: { ...thread },
      scope: { view: 'conversation-v1', kind: sessionId === null ? 'single-thread' : 'session-grants', limited: sessionId === null,
        key: conversationScopeKey(seed, sessionId) },
      ...conversationPage(seed, sessionId, cursor, size, view),
      autoReplyQuestions: typeof customerQuestions === 'function' ? customerQuestions(seed) : [], ...uploadsInfo() };
  }

  /* ---------- общая запись сообщения и доставок ---------- */
  function insertMessage({ thread, direction, author, source, text, webSessionId = null, ownerUserId = null, botKey = null, tgChatId = null, tgMessageId = null, skipCustomerReply = false, automatic = false }) {
    const at = stamp();
    const id = Number(db.prepare(`INSERT INTO chat_thread_messages(thread_id,direction,author_kind,source_channel,text,created_at,web_session_id,owner_user_id,bot_key,tg_chat_id,tg_message_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(thread.id, direction, author, source, text, at, webSessionId, ownerUserId, botKey, tgChatId, tgMessageId).lastInsertRowid);
    db.prepare('UPDATE chat_threads SET updated_at=?, last_message_at=? WHERE id=?').run(at, at, thread.id);
    if (!automatic && !skipCustomerReply && direction === 'in' && author === 'customer' && attribution) {
      attribution.recordThread({ thread, messageId: id, source });
    }
    if (typeof onMessageStored === 'function') {
      // Optional local notification enqueue only. No network during the chat transaction.
      // A broken notification adapter must not lose the customer's real message.
      const human = !automatic && !skipCustomerReply && (
        (direction === 'in' && author === 'customer' && (source === 'web' || (source === 'telegram' && tgMessageId !== null))) ||
        (direction === 'out' && author === 'owner' && source === 'app' && Number.isSafeInteger(ownerUserId) && ownerUserId > 0) ||
        (direction === 'out' && author === 'manager' && source === 'manager_telegram' && tgMessageId !== null));
      try { onMessageStored({ thread, messageId: id, direction, author, source, human }); }
      catch (_) { console.warn('palitra: локальная очередь уведомлений недоступна'); }
    }
    if (!skipCustomerReply && direction === 'in' && author === 'customer' && typeof onCustomerMessage === 'function') {
      onCustomerMessage({ thread, messageId: id, source,
        append: replyText => appendAutomaticReply(thread, replyText) });
    }
    return id;
  }
  // Тот же canonical путь магазина: история, notification hook и подтверждённый канал клиента.
  function appendAutomaticReply(thread, replyText) {
    const body = textOf(replyText, MAX_TEXT);
    const id = insertMessage({ thread, direction: 'out', author: 'manager', source: 'app', text: body });
    planCustomer(thread, id, body);
    return id;
  }
  function addDelivery(messageId, channel, status, { jobRef = null, reason = '', botKey = null, chatId = null, channelId = null } = {}) {
    const at = stamp();
    db.prepare(`INSERT INTO chat_message_deliveries(message_id,channel,status,job_ref,reason,bot_key,target_chat_id,channel_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(messageId, channel, status, jobRef, oneLine(reason, 300), botKey, chatId, channelId, at, at);
  }
  const managerText = (thread, text, source) => `${source === 'telegram' ? '✉️ Telegram' : '💬 Сайт'} · чат №${thread.id}${thread.order_id ? ` · заявка №${thread.order_id}` : ''}\n${text}`;
  /* Копия менеджеру: только обычный sendMessage действующему менеджеру; без бота/менеджера/моста — явный not_queued. */
  function managerBlock(site) {
    const botKey = botOf(site);
    const operator = botKey ? operatorOf(botKey) : null;
    const reason = !botKey ? 'Клиентский бот не подключён' : !operator ? 'Менеджер бота не привязан' : !ready(botKey) ? 'Нет связи с Telegram'
      : typeof enqueue !== 'function' ? 'Очередь Telegram не подключена' : '';
    return { botKey, operator, reason };
  }
  // PHASED1: короткая шапка перед копией вложения менеджеру; подпись (caption) Telegram копирует сам — второй текстовой копии нет.
  const managerHeader = (thread, source, copy) => `${copy.edited ? '✏️ Изменено · ' : ''}${source === 'telegram' ? '✉️ Telegram' : '💬 Сайт'} · чат №${thread.id}`
    + `${thread.order_id ? ` · заявка №${thread.order_id}` : ''} · ${KIND_LABEL[copy.kind] || 'вложение'}`;
  // PHASED1 (M2): копия собственного сообщения клиента с сайта в его Telegram ясно подписана; исходный текст сохраняется.
  const selfWebText = (text) => `${SELF_WEB_LABEL}\n${text}`;
  /* Источник copyMessage сообщения с вложением: только сохранённое проверенное сообщение Telegram (для события правки —
     то же исходное сообщение) того же бота. У текстовых сообщений источника нет: им — обычный sendMessage. */
  function copySourceOf(messageId) {
    const row = messageRow(messageId);
    if (!row) return null;
    const event = eventOf(row.id);
    const original = event ? event.replaces_message_id : row.id;
    const botKey = event ? event.bot_key : row.bot_key;
    const chatId = telegramId(event ? event.tg_chat_id : row.tg_chat_id);
    const tgMessageId = positiveId(event ? event.tg_message_id : row.tg_message_id);
    if (!botKey || !chatId || !tgMessageId) return null;
    const latest = db.prepare(`SELECT kind FROM chat_thread_attachments WHERE message_id=? OR message_id IN
      (SELECT message_id FROM chat_thread_media_events WHERE replaces_message_id=? AND message_id<=?) ORDER BY id DESC LIMIT 1`).get(original, original, row.id);
    return latest ? { botKey, chatId, messageId: tgMessageId, kind: latest.kind, edited: Boolean(event) } : null;
  }
  // Прежняя версия media-сообщения: после неё пришло событие правки — её неотправленная копия уже не та версия.
  function superseded(messageId) {
    const event = eventOf(messageId);
    const original = event ? event.replaces_message_id : messageId;
    return Boolean(db.prepare('SELECT 1 FROM chat_thread_media_events WHERE replaces_message_id=? AND message_id>? LIMIT 1').get(original, messageId));
  }
  /* Задание копии менеджеру. PHASEE: файл с сайта — method 'upload' (адаптер строит часть sendPhoto/sendDocument из журнала):
     подпись ≤ 1024 — подписью файла, шапка — отдельным sendMessage; длиннее — шапка и текст прежними частями, файл без подписи. */
  function managerJobOf(thread, messageId, text, source, { botKey, operator, copy = null, upload = null }) {
    const base = { target: 'manager', site: thread.site, botKey, chatId: operator, operatorTelegramId: operator, threadId: thread.id, messageId };
    if (upload) {
      const plan = uploadKit.captionPlan(text, { header: managerHeader(thread, source, { kind: upload.kind || 'document', edited: false }) });
      return { ...base, method: 'upload', text: plan.text, upload: { ref: uploadKit.uploadRef(upload.upload_uuid), caption: plan.caption } };
    }
    return copy ? { ...base, method: 'copyMessage', text: managerHeader(thread, source, copy), copy: { fromChatId: copy.chatId, messageId: copy.messageId } }
      : { ...base, method: 'sendMessage', text: managerText(thread, text, source) };
  }
  // Копия клиенту: text — уже итоговый текст (у своего сообщения клиента — с подписью «Вы написали на сайте»).
  function customerJobOf(thread, messageId, text, channel, { copy = null, upload = null }) {
    const base = { target: 'customer', site: thread.site, botKey: channel.bot_key, chatId: channel.chat_id, operatorTelegramId: operatorOf(channel.bot_key), threadId: thread.id, messageId };
    if (upload) {
      const plan = uploadKit.captionPlan(text);
      return { ...base, method: 'upload', text: plan.text, upload: { ref: uploadKit.uploadRef(upload.upload_uuid), caption: plan.caption } };
    }
    return { ...base, method: copy ? 'copyMessage' : 'sendMessage', text: copy ? '' : text, ...(copy ? { copy: { fromChatId: copy.chatId, messageId: copy.messageId } } : {}) };
  }
  // PHASEE (M2): копия своего файла клиенту без подписи — одна строка «Вы написали на сайте:» без пустого хвоста.
  const selfBody = (text) => (text ? selfWebText(text) : SELF_WEB_LABEL);
  function planManager(thread, messageId, text, source, copy = null, upload = null) {
    const { botKey, operator, reason } = managerBlock(thread.site);
    if (reason) return addDelivery(messageId, 'manager_telegram', 'not_queued', { reason, botKey, chatId: operator });
    if (copy && copy.botKey !== botKey) return addDelivery(messageId, 'manager_telegram', 'not_queued', { reason: 'Клиентский бот изменён', botKey, chatId: operator });
    const jobRef = callEnqueue(managerJobOf(thread, messageId, text, source, { botKey, operator, copy, upload }));
    return addDelivery(messageId, 'manager_telegram', 'queued', { jobRef, botKey, chatId: operator });
  }
  function customerBlock(site, channel) {
    const botKey = botOf(site);
    return botKey !== channel.bot_key ? 'Клиентский бот изменён' : !ready(botKey) ? 'Нет связи с Telegram'
      : typeof enqueue !== 'function' ? 'Очередь Telegram не подключена' : '';
  }
  /* Копия клиенту в Telegram — только в подтверждённый активный канал этого чата; канала нет — доставки нет (только сайт).
     PHASED1: вложение ответа менеджера — copyMessage его настоящего сообщения, без текстовой копии caption. */
  function planCustomer(thread, messageId, text, copy = null, upload = null) {
    const channel = activeChannel(thread.id);
    if (!channel) return;
    const reason = copy && copy.botKey !== channel.bot_key ? 'Клиентский бот изменён' : customerBlock(thread.site, channel);
    const base = { botKey: channel.bot_key, chatId: channel.chat_id, channelId: channel.id };
    if (reason) { addDelivery(messageId, 'customer_telegram', 'not_queued', { ...base, reason }); return; }
    const jobRef = callEnqueue(customerJobOf(thread, messageId, text, channel, { copy, upload }));
    addDelivery(messageId, 'customer_telegram', 'queued', { ...base, jobRef });
  }

  /* ---------- идемпотентность запросов сайта и владельца ---------- */
  function replayOf(kind, actorRef, requestId, fingerprint, view) {
    const row = db.prepare('SELECT * FROM chat_thread_requests WHERE actor_kind=? AND actor_ref=? AND request_id=?').get(kind, actorRef, requestId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) fail(409, 'Этот requestId уже использован для другого сообщения', 'REQUEST_MISMATCH');
    return { ok: true, duplicate: true, threadId: row.thread_id, message: view(messageRow(row.message_id)) };
  }
  function saveRequest(kind, actorRef, version, requestId, fingerprint, threadId, messageId) {
    db.prepare(`INSERT INTO chat_thread_requests(actor_kind,actor_ref,actor_session_version,request_id,fingerprint,thread_id,message_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(kind, actorRef, version, requestId, fingerprint, threadId, messageId, stamp());
  }
  const ownerOfRequest = (messageId) => {
    const req = db.prepare("SELECT actor_ref, actor_session_version FROM chat_thread_requests WHERE message_id=? AND actor_kind='owner'").get(messageId);
    return req ? { id: Number(String(req.actor_ref).slice('owner:'.length)), version: req.actor_session_version } : null;
  };

  /* ---------- чат заявки на сайте ---------- */
  function grantedThread(session, cfg, threadId) {
    const row = db.prepare(`SELECT t.* FROM chat_threads t JOIN chat_web_grants g ON g.thread_id=t.id
      WHERE g.session_id=? AND t.id=? AND t.site=? AND t.company_code=?`).get(session.id, threadId, cfg.site, cfg.companyCode);
    return row || fail(404, 'Чат не найден', 'THREAD');
  }
  // Только после web resolve/grant: внутренний адаптер подтверждает canonical order binding.
  // Неизвестное состояние не означает незавершённый заказ; optional projection не прячет историю при сбое.
  function customerOrderLifecycleFields(thread) {
    if (thread.site !== 'palitra' || thread.company_code !== 'palitra-love' || !positiveId(thread.order_id)
      || typeof customerOrderLifecycle !== 'function') return {};
    try {
      const value = customerOrderLifecycle(Object.freeze({ ...thread }));
      if (!value || value.orderId !== thread.order_id || typeof value.completed !== 'boolean') return {};
      return { orderLifecycle: { orderId: thread.order_id, completed: value.completed } };
    } catch (_) { return {}; }
  }
  /* Только для НОВОЙ принятой заявки, в той же транзакции, что и заявка: чат + доступ этой проверенной сессии. */
  function createNewOrderThread(request, { orderId, orderMessage = null } = {}) {
    const id = positiveId(orderId);
    if (!id) fail(400, 'Некорректный номер заявки', 'VALIDATION');
    return tx(() => {
      const { session, cfg } = resolve(request);
      if (typeof orderExists === 'function' && orderExists(cfg.site, id) !== true) fail(404, 'Заявка не найдена', 'ORDER');
      if (db.prepare('SELECT id FROM chat_threads WHERE site=? AND order_id=?').get(cfg.site, id)) fail(409, 'У этой заявки уже есть чат', 'THREAD_EXISTS');
      const at = stamp();
      const threadId = Number(db.prepare('INSERT INTO chat_threads(site,company_code,order_id,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(cfg.site, cfg.companyCode, id, at, at).lastInsertRowid);
      db.prepare('INSERT INTO chat_web_grants(session_id,thread_id,created_at) VALUES(?,?,?)').run(session.id, threadId, at);
      if (orderMessage !== null) {
        // A stored server snapshot of this accepted order, never a second HTTP send. The native order outbox
        // already notifies the manager; no duplicate chat Telegram job is planned for this message.
        // 30 items with 120-char titles + validated contact/delivery/comment fit this separate bound.
        const text = textOf(orderMessage, 8192), thread = threadRow(threadId);
        const messageId = insertMessage({ thread, direction: 'in', author: 'customer', source: 'web', text,
          webSessionId: session.id, skipCustomerReply: true });
        // Reserved non-UUID request key: ordinary web/upload request validation cannot claim this marker.
        // Followup excludes exactly this server-authored checkout entry, not subsequent customer messages.
        saveRequest('web', `session:${session.id}`, null, `checkout-order:${id}`,
          sha256(JSON.stringify({ threadId, text })), threadId, messageId);
      }
      if (typeof onOrderThreadCreated === 'function') {
        const thread = threadRow(threadId);
        let open = true, appended = false;
        try {
          onOrderThreadCreated({ thread: Object.freeze({ ...thread }), orderId: id,
            append: replyText => {
              if (!open || appended) fail(409, 'Автоответ этой заявки уже обработан', 'ORDER_REPLY_SCOPE');
              const messageId = appendAutomaticReply(thread, replyText);
              appended = true;
              return messageId;
            } });
        } finally { open = false; }
      }
      return { ok: true, thread: threadView(threadRow(threadId)) };
    });
  }
  /* Повтор заявки (duplicate): доступ только если он уже есть у ЭТОЙ сессии; новый доступ здесь не выдаётся. */
  function findOwnedOrder(request, { orderId } = {}) {
    const id = positiveId(orderId);
    if (!id) fail(400, 'Некорректный номер заявки', 'VALIDATION');
    const { session, cfg } = resolve(request);
    const row = db.prepare(`SELECT t.* FROM chat_threads t JOIN chat_web_grants g ON g.thread_id=t.id
      WHERE g.session_id=? AND t.site=? AND t.company_code=? AND t.order_id=?`).get(session.id, cfg.site, cfg.companyCode, id);
    return { thread: row ? threadView(row) : null };
  }
  /* Navigation-only read: use the existing cookie/grants without issuing, rotating,
     extending or touching a session. No thread, order or account metadata leaves
     this method; a local history hint never substitutes for this access check. */
  function peekWebHistory(request) {
    const { session, cfg } = resolve(request, { csrf: false });
    const found = db.prepare(`SELECT 1 FROM chat_web_grants g JOIN chat_threads t ON t.id=g.thread_id
      WHERE g.session_id=? AND t.site=? AND t.company_code=? LIMIT 1`)
      .get(session.id, cfg.site, cfg.companyCode);
    return { hasHistory: Boolean(found) };
  }
  function listMyThreads(request, { before, limit } = {}) {
    const size = limitOf(limit), cursor = cursorOf(before);
    const { session, cfg } = resolve(request);
    const rows = db.prepare(`SELECT t.* FROM chat_threads t JOIN chat_web_grants g ON g.thread_id=t.id
      WHERE g.session_id=? AND t.site=? AND t.company_code=? AND (? IS NULL OR t.id<?) ORDER BY t.id DESC LIMIT ?`)
      .all(session.id, cfg.site, cfg.companyCode, cursor, cursor, size + 1);
    const { list, nextBefore } = page(rows, size);
    return { threads: list.map(threadView), nextBefore };
  }
  function listWebMessages(request, { threadId, before, limit } = {}) {
    const id = positiveId(threadId), size = limitOf(limit), cursor = cursorOf(before);
    if (!id) fail(404, 'Чат не найден', 'THREAD');
    const { session, cfg } = resolve(request);
    const thread = grantedThread(session, cfg, id);
    const result = { thread: threadView(thread), ...messagesPage(thread.id, cursor, size, customerMessageView),
      contactRequest: contactRequest(thread), autoReplyQuestions: typeof customerQuestions === 'function' ? customerQuestions(thread) : [], ...uploadsInfo() };
    const fresh = resolve(request);
    if (fresh.session.id !== session.id) fail(403, 'Доступ к переписке изменился', 'SESSION');
    const freshThread = grantedThread(fresh.session, fresh.cfg, id);
    return freshThread.order_id === thread.order_id ? { ...result, contactRequest: webContactRequest(request, session, freshThread), ...customerOrderLifecycleFields(freshThread) } : result;
  }
  function listWebConversation(request, { threadId, before, limit } = {}) {
    const id = positiveId(threadId), size = limitOf(limit), cursor = cursorOf(before);
    if (!id) fail(404, 'Чат не найден', 'THREAD');
    const { session, cfg } = resolve(request);
    const seed = grantedThread(session, cfg, id);
    const result = { ...conversationView(seed, session.id, cursor, size, customerMessageView), contactRequest: contactRequest(seed) };
    // Чтение общей истории не восстанавливает истёкшую/отозванную сессию и не создаёт новых grants.
    const fresh = resolve(request);
    if (fresh.session.id !== session.id) fail(403, 'Доступ к переписке изменился', 'SESSION');
    const freshSeed = grantedThread(fresh.session, fresh.cfg, id);
    const contact = freshSeed.order_id === seed.order_id ? webContactRequest(request, session, freshSeed) : result.contactRequest;
    if (result.scope.key !== conversationScopeKey(seed, session.id)) fail(409, 'Состав доступной переписки изменился. Обновите её.', 'CONVERSATION_SCOPE_CHANGED');
    return freshSeed.order_id === seed.order_id ? { ...result, contactRequest: contact, ...customerOrderLifecycleFields(freshSeed) } : result;
  }
  function rateCheck(sessionId) {
    const since = (ms) => db.prepare('SELECT count(*) AS n FROM chat_thread_messages WHERE web_session_id=? AND created_at>=?').get(sessionId, stamp(now() - ms)).n;
    if (since(WEB_RATE.windowMs) >= WEB_RATE.perWindow || since(DAY) >= WEB_RATE.perDay) fail(429, 'Слишком много сообщений подряд. Подождите немного', 'RATE_LIMITED');
  }
  /* Сообщение клиента с сайта: одна запись истории (stored) + копия менеджеру (queued или явный not_queued). */
  function postWebMessage(request, body) {
    const input = exactKeys(body, ['requestId', 'text', 'threadId']);
    const threadId = positiveId(input.threadId);
    if (!threadId) fail(404, 'Чат не найден', 'THREAD');
    const requestId = requestIdOf(input.requestId);
    const text = textOf(input.text, MAX_TEXT);
    const fingerprint = sha256(JSON.stringify({ threadId, text }));
    return tx(() => {
      const { session, cfg } = resolve(request);
      // Доступ к чату проверяется до квитанции повтора; лимит частоты — после неё (повтор не упирается в лимит).
      const thread = grantedThread(session, cfg, threadId);
      const actorRef = `session:${session.id}`;
      const replay = replayOf('web', actorRef, requestId, fingerprint, customerMessageView);
      if (replay) return replay;
      fileRequestConflict('web', actorRef, requestId);
      rateCheck(session.id);
      const messageId = insertMessage({ thread, direction: 'in', author: 'customer', source: 'web', text, webSessionId: session.id });
      planManager(thread, messageId, text, 'web');
      // PHASED1 (M1/M2): копия своего сообщения клиенту — только в подтверждённый канал, с подписью «Вы написали на сайте».
      if (mirrorCustomerWebToTelegram) planCustomer(thread, messageId, selfWebText(text));
      saveRequest('web', actorRef, null, requestId, fingerprint, thread.id, messageId);
      return { ok: true, duplicate: false, threadId: thread.id, message: customerMessageView(messageRow(messageId)) };
    });
  }
  // Виджет и приложение начинают один и тот же чат только после явной отправки.
  // Квитанция start закрепляет первоначальную цель: повтор не создаёт новый thread после появления других заявок.
  function startWebConversation(request, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Некорректное начало переписки', 'VALIDATION');
    const kind = Object.hasOwn(body, 'text') ? 'text' : Object.hasOwn(body, 'phone') ? 'phone' : Object.hasOwn(body, 'upload') ? 'upload' : '';
    if (Object.hasOwn(body, 'attributionToken') && (typeof body.attributionToken !== 'string' || !/^[0-9a-f-]{36}\.[0-9a-f]{64}$/i.test(body.attributionToken))) fail(400, 'Некорректная метка перехода', 'VALIDATION');
    if (!kind || Object.keys(body).filter(key => key !== 'attributionToken').sort().join(',') !== ['requestId', kind].sort().join(',')) {
      fail(400, 'Отправьте одно сообщение, номер или файл', 'VALIDATION');
    }
    const requestId = requestIdOf(body.requestId);
    const text = kind === 'text' ? textOf(body.text, MAX_TEXT) : null;
    const phone = kind === 'phone' ? widgetPhoneOf(body.phone) : null;
    const store = kind === 'upload' ? requireUploads({ write: false }) : null;
    const upload = kind === 'upload' ? uploadKit.prepareInput({ ...body.upload, requestId }, { maxFile: Math.min(maxFile, store.maxFile) }) : null;
    const fingerprint = sha256(JSON.stringify({ kind, value: text ?? phone ?? upload }));
    return tx(() => {
      const { session, cfg } = resolve(request);
      const actorRef = `session:${session.id}`;
      const previous = db.prepare('SELECT * FROM chat_widget_starts WHERE session_id=? AND request_id=?').get(session.id, requestId);
      if (previous) {
        if (previous.kind !== kind || previous.fingerprint !== fingerprint) fail(409, 'Этот requestId уже использован для другой отправки', 'REQUEST_MISMATCH');
        const thread = grantedThread(session, cfg, previous.thread_id);
        const result = { ok: true, duplicate: true, threadId: thread.id, thread: threadView(thread) };
        if (previous.message_id) {
          const message = messageRow(previous.message_id);
          if (!message || message.thread_id !== thread.id) fail(409, 'Квитанция переписки изменилась', 'START_RECEIPT');
          result.message = customerMessageView(message);
        } else if (previous.upload_uuid) {
          const row = db.prepare('SELECT * FROM chat_web_uploads WHERE upload_uuid=? AND actor_kind=? AND actor_ref=? AND thread_id=?')
            .get(previous.upload_uuid, 'web', actorRef, thread.id);
          if (!row) fail(409, 'Квитанция файла изменилась', 'START_RECEIPT');
          Object.assign(result, uploadAnswer(store, row, true, customerMessageView));
        }
        return { ...result, contactRequest: contactRequest(thread) };
      }
      // Всё пространство requestId одного автора общее для start, обычного текста, контакта и файла.
      if (textRequestUsed('web', actorRef, requestId) || uploadStore()?.requestUsed('web', actorRef, requestId)) {
        fail(409, 'Этот requestId уже использован для другой отправки', 'REQUEST_MISMATCH');
      }
      rateCheck(session.id);
      if (kind === 'upload') requireUploads();
      let thread = db.prepare(`SELECT t.* FROM chat_threads t JOIN chat_web_grants g ON g.thread_id=t.id
        WHERE g.session_id=? AND t.site=? AND t.company_code=? ORDER BY t.id DESC LIMIT 1`)
        .get(session.id, cfg.site, cfg.companyCode);
      if (!thread) {
        const at = stamp();
        const id = Number(db.prepare('INSERT INTO chat_threads(site,company_code,order_id,created_at,updated_at) VALUES(?,?,NULL,?,?)')
          .run(cfg.site, cfg.companyCode, at, at).lastInsertRowid);
        db.prepare('INSERT INTO chat_web_grants(session_id,thread_id,created_at) VALUES(?,?,?)').run(session.id, id, at);
        thread = threadRow(id);
      }
      if (attribution) attribution.rememberThread({ thread, origin: request.origin, token: body.attributionToken });
      let message = null, uploadAnswerValue = null, uploadUuid = null;
      if (kind === 'text') {
        const answer = postWebMessage(request, { threadId: thread.id, requestId, text });
        message = answer.message;
      } else if (kind === 'phone') {
        const answer = writeWebContact(session, cfg, thread, requestId, phone);
        message = answer.message;
      } else {
        uploadAnswerValue = prepareWebUpload(request, { threadId: thread.id, body: { ...upload, requestId } });
        const row = db.prepare('SELECT upload_uuid FROM chat_web_uploads WHERE actor_kind=? AND actor_ref=? AND request_id=?')
          .get('web', actorRef, requestId);
        if (!row) fail(409, 'Квитанция файла не найдена', 'START_RECEIPT');
        uploadUuid = row.upload_uuid;
      }
      const fresh = resolve(request);
      if (fresh.session.id !== session.id) fail(403, 'Доступ к переписке изменился', 'SESSION');
      grantedThread(fresh.session, fresh.cfg, thread.id);
      db.prepare(`INSERT INTO chat_widget_starts(session_id,request_id,kind,fingerprint,thread_id,message_id,upload_uuid,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(session.id, requestId, kind, fingerprint, thread.id, message?.id ?? null, uploadUuid, stamp());
      return { ok: true, duplicate: false, threadId: thread.id, thread: threadView(threadRow(thread.id)),
        ...(message ? { message } : {}), ...(uploadAnswerValue ? { upload: uploadAnswerValue.upload } : {}),
        contactRequest: contactRequest(thread) };
    });
  }
  function writeWebContact(session, cfg, thread, requestId, phone) {
    const actorRef = `session:${session.id}`;
    const fingerprint = sha256(JSON.stringify({ kind: 'contact', threadId: thread.id, phone }));
    const replay = replayOf('web', actorRef, requestId, fingerprint, customerMessageView);
    if (replay) return replay;
    fileRequestConflict('web', actorRef, requestId);
    rateCheck(session.id);
    const text = widgetPhoneMessage(phone);
    const messageId = insertMessage({ thread, direction: 'in', author: 'customer', source: 'web', text, webSessionId: session.id });
    planManager(thread, messageId, text, 'web');
    if (mirrorCustomerWebToTelegram) planCustomer(thread, messageId, selfWebText(text));
    saveRequest('web', actorRef, null, requestId, fingerprint, thread.id, messageId);
    db.prepare(`INSERT INTO chat_thread_contacts(thread_id,session_id,phone,message_id,provided_at) VALUES(?,?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET session_id=excluded.session_id,phone=excluded.phone,
      message_id=excluded.message_id,provided_at=excluded.provided_at`)
      .run(thread.id, session.id, phone, messageId, stamp());
    return { ok: true, duplicate: false, threadId: thread.id, message: customerMessageView(messageRow(messageId)) };
  }
  function provideWebContact(request, body) {
    const input = exactKeys(body, ['threadId', 'requestId', 'phone']);
    const id = positiveId(input.threadId);
    if (!id) fail(404, 'Чат не найден', 'THREAD');
    const requestId = requestIdOf(input.requestId), phone = widgetPhoneOf(input.phone);
    return tx(() => {
      const { session, cfg } = resolve(request);
      const thread = grantedThread(session, cfg, id);
      const answer = writeWebContact(session, cfg, thread, requestId, phone);
      const fresh = resolve(request);
      if (fresh.session.id !== session.id) fail(403, 'Доступ к переписке изменился', 'SESSION');
      grantedThread(fresh.session, fresh.cfg, id);
      return { ...answer, contactRequest: contactRequest(thread) };
    });
  }
  /* Одноразовая ссылка t.me/<bot>?start=<startPayload>: только своей сессии, только для своего чата, 30 минут.
     Отправить START за клиента нельзя (Telegram) — UI покажет кнопку; чат сайта работает и без этого. */
  function issueTelegramLink(request, { threadId } = {}) {
    const id = positiveId(threadId);
    if (!id) fail(404, 'Чат не найден', 'THREAD');
    return tx(() => {
      const { session, cfg } = resolve(request);
      const thread = grantedThread(session, cfg, id);
      const botKey = botOf(cfg.site);
      if (!botKey) fail(409, 'Telegram для этого магазина не подключён', 'BOT_DISABLED');
      if (!ready(botKey)) fail(503, 'Telegram сейчас недоступен — пишите здесь, менеджер ответит в этом чате', 'BRIDGE_NOT_READY');
      const recent = db.prepare('SELECT count(*) AS n FROM chat_thread_links WHERE session_id=? AND created_at>=?').get(session.id, stamp(now() - LINK_RATE.windowMs)).n;
      if (recent >= LINK_RATE.max) fail(429, 'Слишком много ссылок подряд. Подождите немного', 'RATE_LIMITED');
      const at = now();
      // Прежние неиспользованные ссылки этой сессии на этот чат гасятся: действует только последняя.
      db.prepare('UPDATE chat_thread_links SET expires_at=? WHERE session_id=? AND thread_id=? AND used_at IS NULL AND expires_at>?')
        .run(stamp(at), session.id, thread.id, stamp(at));
      const token = randomBytes(24).toString('base64url');
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) fail(500, 'Не удалось создать ссылку', 'RANDOM');
      const expiresAt = stamp(at + LINK_TTL);
      db.prepare('INSERT INTO chat_thread_links(token_hash,thread_id,session_id,bot_key,created_at,expires_at) VALUES(?,?,?,?,?,?)')
        .run(sha256(token), thread.id, session.id, botKey, stamp(at), expiresAt);
      return { ok: true, startPayload: `c_${token}`, expiresAt };
    });
  }

  /* ---------- Telegram (вызывает мост phaseB ДО legacy upsertDialog; поля Telegram — только из проверенного update) ---------- */
  /* START c_<token> от настоящего пользователя в личном чате с ботом. Чужой формат — { claimed:false, reason:'FORMAT' }:
     обработка идёт прежним путём. Переключение активного чата не сливает истории и не даёт доступа к прежним. */
  function claimTelegramLink({ botKey, startPayload, telegramUserId, chatId } = {}) {
    const match = LINK_PAYLOAD.exec(String(startPayload || ''));
    if (!match) return { claimed: false, reason: 'FORMAT' };
    const user = telegramId(telegramUserId), chat = telegramId(chatId);
    if (!BOT_KEY.test(String(botKey || '')) || !user || chat !== user) fail(422, 'Принимаются только личные сообщения', 'NOT_PRIVATE');
    return tx(() => {
      const link = db.prepare('SELECT * FROM chat_thread_links WHERE token_hash=?').get(sha256(match[1]));
      if (!link || link.bot_key !== botKey) return { claimed: false, reason: 'UNKNOWN' };
      const thread = threadRow(link.thread_id);
      if (!thread || botOf(thread.site) !== botKey) return { claimed: false, reason: 'UNKNOWN' };
      if (link.used_at) {
        // Повтор того же START тем же пользователем — тот же результат; ссылка чужому не переходит.
        const current = activeChannel(thread.id);
        return link.used_by === user && current && current.telegram_user_id === user
          ? { claimed: true, duplicate: true, threadId: thread.id, previousThreadId: null } : { claimed: false, reason: 'USED' };
      }
      if (!(Date.parse(link.expires_at) > now())) return { claimed: false, reason: 'EXPIRED' };
      const at = stamp();
      db.prepare('UPDATE chat_thread_links SET used_at=?, used_by=? WHERE id=?').run(at, user, link.id);
      const previous = db.prepare("SELECT * FROM chat_thread_channels WHERE bot_key=? AND telegram_user_id=? AND status='active'").get(botKey, user);
      if (previous && previous.thread_id === thread.id) return { claimed: true, duplicate: true, threadId: thread.id, previousThreadId: null };
      if (previous) db.prepare("UPDATE chat_thread_channels SET status='inactive', deactivated_at=?, deactivated_reason='switched' WHERE id=?").run(at, previous.id);
      const replaced = activeChannel(thread.id);
      if (replaced) db.prepare("UPDATE chat_thread_channels SET status='inactive', deactivated_at=?, deactivated_reason='replaced' WHERE id=?").run(at, replaced.id);
      db.prepare("INSERT INTO chat_thread_channels(thread_id,bot_key,telegram_user_id,chat_id,status,verified_at) VALUES(?,?,?,?,'active',?)")
        .run(thread.id, botKey, user, chat, at);
      return { claimed: true, duplicate: false, threadId: thread.id, previousThreadId: previous ? previous.thread_id : null };
    });
  }
  /* ---------- PHASED1: вложения из Telegram ---------- */
  /* Описание вложения от адаптера — результат настоящего mediaOf client-dialogs (kind, file_id, mime, имя, размер,
     признаки стикера, media_group_id). Некорректное описание — как отсутствие вложения: строки-подделки нет. */
  function mediaDescriptor(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = mediaKit.KINDS.includes(value.kind) ? value.kind : null;
    const fileId = typeof value.fileId === 'string' && FILE_ID.test(value.fileId) ? value.fileId : null;
    if (!kind || !fileId) return null;
    const uniqueId = typeof value.fileUniqueId === 'string' && /^[\x21-\x7e]{1,120}$/.test(value.fileUniqueId) ? value.fileUniqueId : '';
    const mime = typeof value.mime === 'string' && MEDIA_MIME.test(value.mime) ? value.mime.toLowerCase() : 'application/octet-stream';
    const name = oneLine(value.name, 180).replace(/[\\/]/g, '_') || `${kind}-file`;
    const size = Number.isSafeInteger(value.size) && value.size > 0 ? value.size : null;
    const flags = value.flags && typeof value.flags === 'object' ? value.flags : {};
    return { kind, fileId, uniqueId, mime, name, size,
      flags: { animated: flags.animated === true, video: flags.video === true, groupId: typeof flags.groupId === 'string' && GROUP_ID.test(flags.groupId) ? flags.groupId : null } };
  }
  /* Общий предел: байты прежних диалогов + вложения чата сайта. Repair R4: actual_size — постоянный учёт фактических
     байтов, записываемый ДО записи файла (резерв) и сохраняемый при любом исходе: сбой базы после записи файла, перезапуск
     или поздний конечный статус не «освобождают» уже лежащие на диске байты. Ожидающее без фактических байтов — его
     известный ожидаемый размер. */
  function typedBytes(exceptId = 0) {
    const row = db.prepare(`SELECT COALESCE(SUM(CASE
        WHEN actual_size IS NOT NULL THEN MAX(actual_size, CASE WHEN status='pending' THEN COALESCE(expected_size,0) ELSE 0 END)
        WHEN status='pending' THEN COALESCE(expected_size,0) ELSE 0 END),0) AS n
      FROM chat_thread_attachments WHERE id<>?`).get(exceptId);
    return Number(row.n) || 0;
  }
  const quotaText = 'Хранилище файлов чата заполнено: файл не сохранён, он остаётся в Telegram';
  const tooLargeText = () => `Файл больше ${Math.round(maxFile / 1024 / 1024)} МБ: сохранены только сведения о нём`;
  function insertAttachment(thread, messageId, botKey, desc, sourceChatId, sourceMessageId) {
    const used = legacyBytes() + typedBytes();
    const status = desc.size && desc.size > maxFile ? 'too_large' : (desc.size ? used + desc.size > maxStorage : used >= maxStorage) ? 'quota_exceeded' : 'pending';
    const at = stamp();
    const id = Number(db.prepare(`INSERT INTO chat_thread_attachments(message_id,thread_id,site,company_code,bot_key,kind,mime,name,expected_size,file_id,file_unique_id,flags,
      source_chat_id,source_message_id,status,disk_name,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(messageId, thread.id, thread.site, thread.company_code, botKey, desc.kind, desc.mime, desc.name, desc.size, desc.fileId, desc.uniqueId,
        JSON.stringify(desc.flags), sourceChatId, sourceMessageId, status, crypto.randomUUID(),
        status === 'too_large' ? tooLargeText() : status === 'quota_exceeded' ? quotaText : '', at, at).lastInsertRowid);
    return id;
  }
  // Текст сообщения Telegram: с вложением подпись может быть пустой; без вложения пустое — «не текст».
  const telegramBody = (text, desc) => { const body = telegramTextOf(text); return body === null ? (desc ? '' : null) : body; };

  /* Сообщение клиента в Telegram. Нет активного канала — { routed:false }: прежний путь. Повтор update — та же запись.
     PHASED1: любое из восьми native вложений сохраняется (сообщение + typed-вложение + copyMessage менеджеру); без
     текста и без вложения — { routed:true, stored:false, reason:'UNSUPPORTED_CONTENT' }. */
  function receiveTelegramCustomerMessage({ botKey, telegramUserId, chatId, messageId, text, media = null } = {}) {
    const user = telegramId(telegramUserId), chat = telegramId(chatId), tgMessageId = positiveId(messageId);
    if (!BOT_KEY.test(String(botKey || '')) || !user || chat !== user || !tgMessageId) fail(422, 'Принимаются только личные сообщения', 'NOT_PRIVATE');
    const desc = mediaDescriptor(media);
    return tx(() => {
      const channel = db.prepare("SELECT * FROM chat_thread_channels WHERE bot_key=? AND telegram_user_id=? AND chat_id=? AND status='active'").get(botKey, user, chat);
      if (!channel) return { routed: false };
      const known = db.prepare('SELECT id, thread_id FROM chat_thread_messages WHERE bot_key=? AND tg_chat_id=? AND tg_message_id=?').get(botKey, chat, tgMessageId);
      if (known) return { routed: true, stored: true, duplicate: true, threadId: known.thread_id, messageId: known.id };
      const thread = threadRow(channel.thread_id);
      if (!thread || botOf(thread.site) !== botKey) return { routed: false };
      const body = telegramBody(text, desc);
      if (body === null) return { routed: true, stored: false, reason: 'UNSUPPORTED_CONTENT', threadId: thread.id };
      const id = insertMessage({ thread, direction: 'in', author: 'customer', source: 'telegram', text: body, botKey, tgChatId: chat, tgMessageId });
      if (desc) insertAttachment(thread, id, botKey, desc, chat, tgMessageId);
      planManager(thread, id, body, 'telegram', desc ? copySourceOf(id) : null);
      return { routed: true, stored: true, duplicate: false, threadId: thread.id, messageId: id };
    });
  }
  /* Ответ менеджера «Ответить» на копию, которую бот прислал ему по этому чату. Доверие — только действующему
     менеджеру и карте квитанций (chat_manager_map); chat_id из тела веб-запроса не используется.
     FR-011: действующий менеджер проверяется до транзакции и повторно ВНУТРИ неё — до квитанции повтора и до записи. */
  function receiveManagerTelegramReply({ botKey, operatorTelegramId, chatId, messageId, replyToMessageId, text, media = null } = {}) {
    const operator = telegramId(operatorTelegramId), chat = telegramId(chatId);
    const tgMessageId = positiveId(messageId), replyTo = positiveId(replyToMessageId);
    if (!BOT_KEY.test(String(botKey || '')) || !operator || chat !== operator || !tgMessageId) fail(422, 'Принимаются только личные сообщения', 'NOT_PRIVATE');
    if (operatorOf(botKey) !== operator) fail(403, 'Ответ принимается только от действующего менеджера', 'OPERATOR');
    const desc = mediaDescriptor(media);
    return tx(() => {
      if (operatorOf(botKey) !== operator) fail(403, 'Ответ принимается только от действующего менеджера', 'OPERATOR');
      const known = db.prepare('SELECT id, thread_id FROM chat_thread_messages WHERE bot_key=? AND tg_chat_id=? AND tg_message_id=?').get(botKey, chat, tgMessageId);
      if (known) return { routed: true, stored: true, duplicate: true, threadId: known.thread_id, messageId: known.id };
      const map = replyTo ? db.prepare('SELECT * FROM chat_manager_map WHERE bot_key=? AND chat_id=? AND message_id=?').get(botKey, chat, replyTo) : null;
      if (!map) return { routed: false };
      const thread = threadRow(map.thread_id);
      if (!thread || botOf(thread.site) !== botKey) return { routed: false };
      const body = telegramBody(text, desc);
      if (body === null) return { routed: true, stored: false, reason: 'UNSUPPORTED_CONTENT', threadId: thread.id };
      const id = insertMessage({ thread, direction: 'out', author: 'manager', source: 'manager_telegram', text: body, botKey, tgChatId: chat, tgMessageId });
      // PHASED1: файл менеджера виден на сайте и в приложении (одна копия байтов); клиенту в Telegram — copyMessage.
      if (desc) insertAttachment(thread, id, botKey, desc, chat, tgMessageId);
      planCustomer(thread, id, body, desc ? copySourceOf(id) : null);
      return { routed: true, stored: true, duplicate: false, threadId: thread.id, messageId: id };
    });
  }

  /* PHASED1: правка в Telegram сообщения с вложением — отдельное canonical событие в том же чате.
     - уникальность — настоящие bot/chat/message/edit_date (без edit_date событие не создаётся: дату не придумываем);
     - то же событие повторно — та же запись; тот же ключ с другим содержимым — явный конфликт, ничего не затирается;
     - новый файл — новое вложение; только подпись — событие без нового файла (прежний файл остаётся у прежней версии);
     - автор проверяется заново: клиент — его активный канал этого чата, менеджер — действующий менеджер;
     - копия: клиентская правка — менеджеру, правка менеджера — клиенту (copyMessage того же сообщения, текущая версия).
     Текстовые сообщения без вложений сюда не попадают ({ event:false }): их правки по-прежнему не переносятся. */
  // Отпечаток содержимого правки: текст (как он сохраняется) и файл (file_unique_id, иначе file_id).
  const editFingerprint = (text, desc) => sha256(JSON.stringify({ text: telegramTextOf(text) ?? '', file: desc ? (desc.uniqueId || desc.fileId) : null }));
  function editReplay(botKey, chat, tgMessageId, date, text, desc) {
    const existing = db.prepare('SELECT * FROM chat_thread_media_events WHERE bot_key=? AND tg_chat_id=? AND tg_message_id=? AND edit_date=?').get(botKey, chat, tgMessageId, date);
    if (!existing) return null;
    const message = messageRow(existing.message_id);
    return existing.fingerprint === editFingerprint(text, desc)
      ? { routed: true, event: true, stored: true, duplicate: true, threadId: message.thread_id, messageId: existing.message_id }
      : { routed: true, event: true, stored: false, conflict: true, threadId: message.thread_id, messageId: existing.message_id };
  }
  /* Repair R2: только сверка повтора уже принятой правки (вызывается при квитанции client-dialogs): ничего не создаёт. */
  function replayTelegramEdit({ botKey, chatId, messageId, editDate, text, media = null } = {}) {
    const chat = telegramId(chatId), tgMessageId = positiveId(messageId), date = positiveId(editDate);
    if (!BOT_KEY.test(String(botKey || '')) || !chat || !tgMessageId || !date) return { routed: false };
    return editReplay(botKey, chat, tgMessageId, date, text, mediaDescriptor(media)) || { routed: false };
  }
  function receiveTelegramEdit({ botKey, chatId, messageId, editDate, text, media = null } = {}) {
    const chat = telegramId(chatId), tgMessageId = positiveId(messageId), date = positiveId(editDate);
    if (!BOT_KEY.test(String(botKey || '')) || !chat || !tgMessageId) fail(422, 'Принимаются только личные сообщения', 'NOT_PRIVATE');
    const desc = mediaDescriptor(media);
    return tx(() => {
      const original = db.prepare('SELECT * FROM chat_thread_messages WHERE bot_key=? AND tg_chat_id=? AND tg_message_id=?').get(botKey, chat, tgMessageId);
      if (!original) return { routed: false };
      const thread = threadRow(original.thread_id);
      if (!thread || botOf(thread.site) !== botKey) return { routed: false };
      const hadMedia = Boolean(db.prepare(`SELECT 1 FROM chat_thread_attachments WHERE message_id=? OR message_id IN
        (SELECT message_id FROM chat_thread_media_events WHERE replaces_message_id=?) LIMIT 1`).get(original.id, original.id));
      if (!hadMedia && !desc) return { routed: true, event: false, threadId: thread.id, messageId: original.id };
      if (!date) return { routed: true, event: false, reason: 'NO_EDIT_DATE', threadId: thread.id, messageId: original.id };
      // Тот же ключ правки уже принят: повтор/конфликт по отпечатку — до проверок автора (повтор не создаёт нового).
      const known = editReplay(botKey, chat, tgMessageId, date, text, desc);
      if (known) return known;
      if (original.author_kind === 'customer') {
        const channel = db.prepare("SELECT * FROM chat_thread_channels WHERE bot_key=? AND telegram_user_id=? AND chat_id=? AND status='active'").get(botKey, chat, chat);
        if (!channel || channel.thread_id !== thread.id) return { routed: true, event: false, reason: 'CHANNEL', threadId: thread.id, messageId: original.id };
      } else if (operatorOf(botKey) !== chat) return { routed: true, event: false, reason: 'OPERATOR', threadId: thread.id, messageId: original.id };
      const body = telegramTextOf(text) ?? '';
      const fingerprint = editFingerprint(text, desc);
      const latest = db.prepare(`SELECT file_id, file_unique_id FROM chat_thread_attachments WHERE message_id=? OR message_id IN
        (SELECT message_id FROM chat_thread_media_events WHERE replaces_message_id=?) ORDER BY id DESC LIMIT 1`).get(original.id, original.id);
      const replaced = Boolean(desc) && (!latest || (latest.file_unique_id || latest.file_id) !== (desc.uniqueId || desc.fileId));
      const id = insertMessage({ thread, direction: original.direction, author: original.author_kind, source: original.source_channel, text: body, botKey, tgChatId: chat });
      db.prepare('INSERT INTO chat_thread_media_events(message_id,replaces_message_id,bot_key,tg_chat_id,tg_message_id,edit_date,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, original.id, botKey, chat, tgMessageId, date, fingerprint, stamp());
      if (replaced) insertAttachment(thread, id, botKey, desc, chat, tgMessageId);
      const copy = copySourceOf(id);
      if (original.author_kind === 'customer') planManager(thread, id, body, 'telegram', copy);
      else planCustomer(thread, id, body, copy);
      return { routed: true, event: true, stored: true, duplicate: false, replaced, threadId: thread.id, messageId: id };
    });
  }

  /* PHASED1: скачивание мостом. Только ожидающие вложения этого бота и этой записи; сохранённые больше не выдаются. */
  function pendingDownloads({ botKey, messageId } = {}) {
    const id = positiveId(messageId);
    if (!id || !BOT_KEY.test(String(botKey || ''))) return [];
    return db.prepare("SELECT id, file_id, expected_size FROM chat_thread_attachments WHERE bot_key=? AND message_id=? AND status='pending' ORDER BY id")
      .all(botKey, id).map((row) => ({ attachmentId: mediaKit.typedRef(row.id), fileId: row.file_id, size: row.expected_size }));
  }
  function attachmentInScope(botKey, ref) {
    const id = mediaKit.parseTypedRef(ref);
    if (!id || !BOT_KEY.test(String(botKey || ''))) fail(404, 'Вложение не найдено', 'NOT_FOUND');
    const row = db.prepare('SELECT * FROM chat_thread_attachments WHERE id=? AND bot_key=?').get(id, botKey);
    const message = row ? messageRow(row.message_id) : null;
    const thread = row ? threadRow(row.thread_id) : null;
    const cfg = thread ? config.get(thread.site) : null;
    if (!row || !message || !thread || message.thread_id !== thread.id || !cfg || thread.company_code !== cfg.companyCode
      || row.site !== thread.site || row.company_code !== thread.company_code || botOf(thread.site) !== botKey) fail(404, 'Вложение не найдено', 'NOT_FOUND');
    return row;
  }
  /* Байты от моста (после getFile). Повтор после потерянного ответа — тот же результат без второго файла; другие байты
     для уже сохранённого — конфликт. Предел файла и общий предел — по фактическим байтам. Область проверяется заново
     в транзакции перед окончательной записью (после чтения тела и записи файла). */
  function saveAttachment({ botKey, attachmentId, bytes } = {}) {
    const row = attachmentInScope(botKey, attachmentId);
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail(400, 'Пустой файл', 'EMPTY');
    const digest = mediaKit.sha256(bytes);
    if (row.status === 'stored') {
      if (row.actual_size !== bytes.length || row.sha256 !== digest) fail(409, 'Вложение уже сохранено с другими байтами', 'CONFLICT');
      return { ok: true, status: 'stored' };
    }
    if (row.status !== 'pending') return { ok: true, status: row.status };
    if (bytes.length > maxFile) return markAttachment({ botKey, attachmentId, status: 'too_large', error: tooLargeText() });
    if (!mediaStorage) fail(503, 'Хранилище вложений не подключено', 'STORAGE');
    /* Repair R4, шаг 1 — резерв: в транзакции заново проверяются область и общий предел по фактическим байтам, и эти
       байты (размер + хеш) записываются в учёт ДО записи файла. Резерв прежней попытки с другими байтами заменяется,
       только если её файла на диске нет; иначе — явный конфликт (готовые байты не трогаются). */
    const reserved = tx(() => {
      const fresh = attachmentInScope(botKey, attachmentId);
      if (fresh.status !== 'pending') return fresh.status;
      if (fresh.actual_size !== null && (fresh.actual_size !== bytes.length || fresh.sha256 !== digest) && mediaStorage.inspect(fresh.disk_name)) {
        fail(409, 'Под этим вложением уже лежат другие байты', 'CONFLICT');
      }
      if (legacyBytes() + typedBytes(fresh.id) + bytes.length > maxStorage) {
        db.prepare("UPDATE chat_thread_attachments SET status='quota_exceeded', error=?, updated_at=? WHERE id=?").run(quotaText, stamp(), fresh.id);
        return 'quota_exceeded';
      }
      db.prepare('UPDATE chat_thread_attachments SET actual_size=?, sha256=?, updated_at=? WHERE id=?').run(bytes.length, digest, stamp(), fresh.id);
      return 'pending';
    });
    if (reserved !== 'pending') return { ok: true, status: reserved };
    // Шаг 2 — файл. Сбой записи: учёт — по тому, что фактически лежит под именем (нет файла — резерв снимается).
    let saved;
    try { saved = mediaStorage.put(row.disk_name, bytes); }
    catch (error) {
      try {
        const onDisk = mediaStorage.inspect(row.disk_name);
        tx(() => db.prepare("UPDATE chat_thread_attachments SET actual_size=?, sha256=?, updated_at=? WHERE id=? AND status='pending'")
          .run(onDisk ? onDisk.size : null, onDisk ? onDisk.sha256 : null, stamp(), row.id));
      } catch (_) { /* учёт остаётся по резерву — с запасом, не с недостачей */ }
      throw error;
    }
    const type = mediaKit.sniff(bytes);
    // Шаг 3 — окончательная запись. Сбой здесь (база, перезапуск) оставляет резерв и файл: повтор тех же байтов
    // переиспользует файл и завершает запись; предел всё это время учитывает лежащие на диске байты.
    return tx(() => {
      const fresh = attachmentInScope(botKey, attachmentId);
      if (fresh.status === 'stored') {
        if (fresh.sha256 !== saved.sha256) fail(409, 'Вложение уже сохранено с другими байтами', 'CONFLICT');
        return { ok: true, status: 'stored' };
      }
      if (fresh.status !== 'pending' || fresh.disk_name !== row.disk_name) return { ok: true, status: fresh.status };
      if (fresh.sha256 !== saved.sha256 || fresh.actual_size !== saved.size) fail(409, 'Учёт вложения изменился во время записи', 'CONFLICT');
      const at = stamp();
      db.prepare("UPDATE chat_thread_attachments SET status='stored', sha256=?, actual_size=?, content_type=?, presentation=?, error='', stored_at=?, updated_at=? WHERE id=?")
        .run(saved.sha256, saved.size, type || 'application/octet-stream', mediaKit.presentationOf(fresh.kind, type), at, at, fresh.id);
      return { ok: true, status: 'stored' };
    });
  }
  function markAttachment({ botKey, attachmentId, status, error } = {}) {
    if (!['too_large', 'unavailable', 'quota_exceeded'].includes(status)) fail(400, 'Некорректный статус вложения', 'VALIDATION');
    return tx(() => {
      const row = attachmentInScope(botKey, attachmentId);
      if (row.status !== 'pending') return { ok: true, status: row.status };
      db.prepare('UPDATE chat_thread_attachments SET status=?, error=?, updated_at=? WHERE id=?')
        .run(status, oneLine(error, 200) || (status === 'too_large' ? tooLargeText() : status === 'quota_exceeded' ? quotaText : 'Telegram не отдал файл боту'), stamp(), row.id);
      return { ok: true, status };
    });
  }
  // Сколько байтов чата сайта уже занято в общем пределе (для подсчёта прежних диалогов).
  const mediaBytes = () => typedBytes();

  /* PHASED1: чтение файла. Покупатель — cookie чата этого адреса (CSRF не нужен только этому чтению), не закрыта и не
     истекла, доступ к этому чату; владелец — действующий владелец. Чужое и не сохранённое — 404 до файловой системы. */
  function attachmentMeta(thread, attachmentId) {
    const id = positiveId(attachmentId);
    const row = id ? db.prepare('SELECT * FROM chat_thread_attachments WHERE id=? AND thread_id=? AND site=? AND company_code=?').get(id, thread.id, thread.site, thread.company_code) : null;
    const message = row ? messageRow(row.message_id) : null;
    if (!row || !message || message.thread_id !== thread.id) fail(404, 'Файл не найден', 'NOT_FOUND');
    if (row.status !== 'stored' || !row.sha256 || !Number.isSafeInteger(row.actual_size)) fail(404, 'Файл ещё не сохранён', 'NOT_STORED');
    // Только для серверной выдачи (не JSON): имя на диске и хеш, с которыми сверяется открываемый файл (repair R5).
    return Object.freeze({ id: row.id, diskName: row.disk_name, size: row.actual_size, sha256: row.sha256, contentType: row.content_type || 'application/octet-stream',
      presentation: row.presentation || 'download', name: row.name, kind: row.kind });
  }
  function webAttachment(request, { threadId, attachmentId } = {}) {
    const id = positiveId(threadId);
    if (!id) fail(404, 'Файл не найден', 'NOT_FOUND');
    const { session, cfg } = resolve(request, { csrf: false });
    return attachmentMeta(grantedThread(session, cfg, id), attachmentId);
  }
  function ownerAttachment({ site, owner, threadId, attachmentId } = {}) {
    requireReader(owner);
    const cfg = siteOf(site), id = positiveId(threadId);
    const thread = id ? db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(id, cfg.site, cfg.companyCode) : null;
    if (!thread) fail(404, 'Файл не найден', 'NOT_FOUND');
    return attachmentMeta(thread, attachmentId);
  }
  function openAttachment(meta) {
    if (!mediaStorage) fail(404, 'Файл не найден', 'NOT_FOUND');
    return mediaStorage.open(meta.diskName, meta.size, meta.sha256);
  }

  /* ---------- приложение владельца ---------- */
  // Последнее сообщение для списка: текст, а у файла без подписи — его вид в скобках.
  function lastText(threadId) {
    const last = db.prepare('SELECT id, text FROM chat_thread_messages WHERE thread_id=? ORDER BY id DESC LIMIT 1').get(threadId);
    if (!last) return '';
    if (last.text) return oneLine(last.text, 160);
    const file = db.prepare('SELECT kind FROM chat_thread_attachments WHERE message_id=? ORDER BY id LIMIT 1').get(last.id);
    return file ? `[${KIND_LABEL[file.kind] || 'вложение'}]` : '';
  }
  function ownerListThreads({ site, owner, before, limit } = {}) {
    requireReader(owner);
    const cfg = siteOf(site), size = limitOf(limit), cursor = cursorOf(before);
    const rows = db.prepare('SELECT * FROM chat_threads WHERE site=? AND company_code=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?')
      .all(cfg.site, cfg.companyCode, cursor, cursor, size + 1);
    const { list, nextBefore } = page(rows, size);
    return { threads: list.map((row) => ({ ...threadView(row),
      lastMessage: lastText(row.id),
      undelivered: db.prepare(`SELECT count(*) AS n FROM chat_message_deliveries d JOIN chat_thread_messages m ON m.id=d.message_id
        WHERE m.thread_id=? AND d.status IN (${UNDELIVERED.map(() => '?').join(',')})`).get(row.id, ...UNDELIVERED).n })), nextBefore };
  }
  // Separate bounded staff projection. Message IDs/cursors and all customer readers stay unchanged.
  function staffAdvisoriesPage(seed, sessionId, owner, adviceAfter, scopeKey) {
    if (typeof ownerAdvisories !== 'function') return {};
    const cursorInput = typeof adviceAfter === 'number' || typeof adviceAfter === 'string' && /^[1-9]\d{0,14}$/.test(adviceAfter);
    const after = adviceAfter === undefined || adviceAfter === null ? null : cursorInput ? positiveId(adviceAfter) : 0;
    if (adviceAfter !== undefined && adviceAfter !== null && !after) fail(400, 'Некорректная страница подсказок', 'ADVICE_CURSOR');
    const predicate = sessionId === null ? 't.id=?' : 'EXISTS (SELECT 1 FROM chat_web_grants g WHERE g.thread_id=t.id AND g.session_id=?)';
    const rows = db.prepare(`SELECT t.id,t.order_id,t.created_at FROM chat_threads t
      WHERE t.site=? AND t.company_code=? AND ${predicate} AND (? IS NULL OR t.id>?) ORDER BY t.id LIMIT 31`)
      .all(seed.site, seed.company_code, sessionId === null ? seed.id : sessionId, after, after);
    const threads = rows.slice(0, 30).map(row => Object.freeze({ id: row.id, orderId: row.order_id ?? null, createdAt: row.created_at }));
    let items = [], status = 'ready';
    try {
      items = ownerAdvisories({ owner, threads: Object.freeze(threads) });
      const source = new Map(threads.map(thread => [thread.id, thread.orderId])), keys = new Set();
      const valid = item => {
        if (!item || item.author !== 'hugh' || item.audience !== 'staff' || item.state !== 'current' || !['workflow', 'contact-followup'].includes(item.kind)
          || !source.has(item.threadId) || source.get(item.threadId) !== item.orderId || !positiveId(item.orderId)
          || typeof item.key !== 'string' || !item.key || item.key.length > 256 || keys.has(item.key)
          || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 1200
          || !['due-at', 'stage-entered', 'order-created'].includes(item.basis) || typeof item.basisAt !== 'string'
          || !Number.isFinite(Date.parse(item.basisAt)) || new Date(item.basisAt).toISOString() !== item.basisAt
          || !Array.isArray(item.actions) || item.actions.length > 2 || !item.actions.some(a => a?.kind === 'order' && a.ref === `native-order:${item.orderId}`)
          || item.actions.some(a => !a || (a.kind === 'order' ? a.ref !== `native-order:${item.orderId}` : a.kind !== 'contact' || !['phone', 'telegram', 'whatsapp', 'max'].includes(a.channel)
            || typeof a.value !== 'string' || !a.value.trim() || a.value.length > 256 || /[\x00-\x1f\x7f]/.test(a.value)))) return false;
        keys.add(item.key); return true;
      };
      if (!Array.isArray(items) || items.length > 60 || !items.every(valid)) fail(503, 'Подсказки сейчас недоступны', 'ADVICE_RESPONSE');
    } catch (error) {
      // Advice is optional; damaged workflow/followup records must not hide ordinary messages.
      // Access and scope failures still abort, and the caller always repeats its fresh guards below.
      if ([401, 403, 409].includes(error?.status)) throw error;
      items = []; status = 'unavailable';
    }
    return { staffAdvisories: { schema: 1, scopeKey, status, items, nextAfterThreadId: rows.length > 30 ? threads[threads.length - 1].id : null } };
  }
  function freshOwnedSeed(seed) {
    const current = threadRow(seed.id);
    return Boolean(current && current.site === seed.site && current.company_code === seed.company_code && current.order_id === seed.order_id);
  }
  function ownerReadThread({ site, owner, threadId, before, limit, adviceAfter } = {}) {
    requireReader(owner);
    const cfg = siteOf(site), id = positiveId(threadId), size = limitOf(limit), cursor = cursorOf(before);
    const thread = id ? db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(id, cfg.site, cfg.companyCode) : null;
    if (!thread) fail(404, 'Чат не найден', 'THREAD');
    const scopeKey = conversationScopeKey(thread, null);
    const result = { thread: threadView(thread), ...messagesPage(thread.id, cursor, size, ownerMessageView), customerContact: customerContact(thread), ...uploadsInfo(),
      ...staffAdvisoriesPage(thread, null, owner, adviceAfter, scopeKey) };
    requireReader(owner);
    if (!freshOwnedSeed(thread)) fail(409, 'Состав доступной переписки изменился. Обновите её.', 'CONVERSATION_SCOPE_CHANGED');
    return result;
  }
  function ownerReadConversation({ site, owner, threadId, before, limit, adviceAfter } = {}) {
    requireReader(owner);
    const cfg = siteOf(site), id = positiveId(threadId), size = limitOf(limit), cursor = cursorOf(before);
    const seed = id ? db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(id, cfg.site, cfg.companyCode) : null;
    if (!seed) fail(404, 'Чат не найден', 'THREAD');
    // Историческая session_id — только ключ группировки для действующего сотрудника, не web-доступ клиента.
    const sessionId = staffConversationSession(seed);
    const result = conversationView(seed, sessionId, cursor, size, ownerMessageView);
    Object.assign(result, { customerContact: customerContact(seed) }, staffAdvisoriesPage(seed, sessionId, owner, adviceAfter, result.scope.key));
    requireReader(owner);
    if (!freshOwnedSeed(seed) || sessionId !== staffConversationSession(seed) || result.scope.key !== conversationScopeKey(seed, sessionId)) fail(409, 'Состав доступной переписки изменился. Обновите её.', 'CONVERSATION_SCOPE_CHANGED');
    return result;
  }
  /* Ответ владельца: одна запись истории (сразу видна на сайте) + копия клиенту только в подтверждённый Telegram.
     FR-012: чат проверяется по site/company ДО квитанции повтора — чужая область не получает прежний receipt. */
  function ownerReply({ site, owner, body } = {}) {
    const who = requireOwner(owner);
    const cfg = siteOf(site);
    const input = exactKeys(body, ['requestId', 'text', 'threadId']);
    const threadId = positiveId(input.threadId);
    if (!threadId) fail(404, 'Чат не найден', 'THREAD');
    const requestId = requestIdOf(input.requestId);
    const text = textOf(input.text, MAX_TEXT);
    const fingerprint = sha256(JSON.stringify({ threadId, text }));
    return tx(() => {
      requireOwner(who);  // повторно внутри транзакции: отзыв между проверкой и записью не проходит
      const thread = db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(threadId, cfg.site, cfg.companyCode);
      if (!thread) fail(404, 'Чат не найден', 'THREAD');
      const actorRef = `owner:${who.id}`;
      const replay = replayOf('owner', actorRef, requestId, fingerprint, ownerMessageView);
      if (replay) {
        if (replay.threadId !== thread.id) fail(404, 'Чат не найден', 'THREAD');
        return replay;
      }
      fileRequestConflict('owner', actorRef, requestId);
      const messageId = insertMessage({ thread, direction: 'out', author: 'owner', source: 'app', text, ownerUserId: who.id });
      planCustomer(thread, messageId, text);
      saveRequest('owner', actorRef, who.sessionVersion, requestId, fingerprint, thread.id, messageId);
      return { ok: true, duplicate: false, threadId: thread.id, message: ownerMessageView(messageRow(messageId)) };
    });
  }

  /* ---------- PHASEE: один файл в чат сайта (покупатель и владелец) ----------
     prepare → bytes (тот же запрос завершает запись) → status (только чтение). Доступ проверяется заново на каждом шаге:
     до чтения тела, после него (до диска) и внутри итоговой транзакции. Номер загрузки, requestId и номер заявки доступа
     не дают. Квитанция — только после завершения: та же форма, что у текстового сообщения ({threadId, message}). */
  function webUploadScope(request, threadId, { csrf = true } = {}) {
    const id = positiveId(threadId);
    if (!id) fail(404, 'Чат не найден', 'THREAD');
    const { session, cfg } = resolve(request, { csrf });
    const thread = grantedThread(session, cfg, id);
    return { session, thread, scope: Object.freeze({ site: thread.site, companyCode: thread.company_code, botKey: botOf(thread.site), actorKind: 'web',
      actorRef: `session:${session.id}`, ownerSessionVersion: null, targetKind: 'thread', targetId: thread.id, sessionId: session.id }) };
  }
  function ownerUploadScope({ site, owner, threadId, write = true }) {
    const who = write ? requireOwner(owner) : requireReader(owner);
    const cfg = siteOf(site), id = positiveId(threadId);
    const thread = id ? db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(id, cfg.site, cfg.companyCode) : null;
    if (!thread) fail(404, 'Чат не найден', 'THREAD');
    return { who, thread, scope: Object.freeze({ site: thread.site, companyCode: thread.company_code, botKey: botOf(thread.site), actorKind: 'owner',
      actorRef: `owner:${who.id}`, ownerSessionVersion: who.sessionVersion, targetKind: 'thread', targetId: thread.id }) };
  }
  const threadReceipt = (row, view) => ({ threadId: row.thread_id, requestId: row.request_id, message: view(messageRow(row.thread_message_id)) });
  const legacyOwnerUsed = (ownerId, requestId) => { try { return typeof ownerLegacyRequestUsed === 'function' && ownerLegacyRequestUsed(ownerId, requestId) === true; } catch (_) { return true; } };
  function uploadAnswer(store, row, duplicate, view, extra) {
    return { ok: true, duplicate, threadId: row.thread_id, upload: store.view(row), ...(store.stateOf(row) === 'committed' ? threadReceipt(row, view) : {}), ...extra };
  }
  function prepareWebUpload(request, { threadId, body } = {}) {
    const store = requireUploads();
    const input = uploadKit.prepareInput(body, { maxFile: Math.min(maxFile, store.maxFile) });
    return tx(() => {
      const { session, scope } = webUploadScope(request, threadId);
      // Лимит частоты — только для новой отправки (повтор той же подготовки в лимит не упирается), как у текста.
      if (!store.requestUsed('web', scope.actorRef, input.requestId)) rateCheck(session.id);
      const { row, duplicate } = store.prepare({ scope, input, crossUsed: () => textRequestUsed('web', scope.actorRef, input.requestId) });
      return uploadAnswer(store, row, duplicate, customerMessageView);
    });
  }
  function webUploadStatus(request, { threadId, uuid } = {}) {
    const store = requireUploads({ write: false });
    const { scope } = webUploadScope(request, threadId, { csrf: false });
    return { ...store.status(uuid, scope, (row) => threadReceipt(row, customerMessageView)), threadId: scope.targetId };
  }
  function beginWebUpload(request, { threadId, uuid } = {}) {
    const store = requireUploads();
    const { scope } = webUploadScope(request, threadId);
    return store.begin(uuid, scope);
  }
  /* После чтения тела: свежий доступ этой же сессии к этому же чату; закрытая/истёкшая сессия, отозванный доступ или
     выключенные загрузки — завершения нет (файл, если уже записан, остаётся готовым и учтённым под тем же UUID). */
  function finishWebUpload(request, { threadId, uuid, claim, bytes } = {}) {
    const store = requireUploads();
    let scope;
    // Доступ пропал, пока читалось тело: приём освобождается (запись снова ждёт тех же байтов), ничего не записано.
    try { ({ scope } = webUploadScope(request, threadId)); } catch (error) { releaseUpload(uuid, claim, 'Доступ к чату изменился'); throw error; }
    const authorize = () => {
      const fresh = webUploadScope(request, threadId).scope;
      if (fresh.actorRef !== scope.actorRef || fresh.targetId !== scope.targetId) fail(403, 'Доступ к чату изменился', 'SESSION');
    };
    const result = store.finish({ uuid, scope, claim, bytes, authorize,
      receipt: (row) => threadReceipt(row, customerMessageView),
      commit: (row) => {
        if (!uploadsOn()) fail(409, 'Отправка файлов пока недоступна — напишите текстом', 'UPLOADS_DISABLED');
        const thread = threadRow(row.thread_id);
        const messageId = insertMessage({ thread, direction: 'in', author: 'customer', source: 'web', text: row.caption, webSessionId: scope.sessionId });
        // insertMessage may call a greeting/notification callback that revokes the session or direct grant.
        // Recheck inside the same upload commit transaction before linking the file or issuing a receipt.
        authorize();
        const linked = store.link(row.upload_uuid, { threadMessageId: messageId });
        planManager(thread, messageId, row.caption, 'web', null, linked);
        // M1/M2: копия своего файла клиенту — только в подтверждённый канал, с подписью «Вы написали на сайте».
        if (mirrorCustomerWebToTelegram) planCustomer(thread, messageId, selfBody(row.caption), null, linked);
        saveRequest('web', scope.actorRef, null, row.request_id, row.fingerprint, thread.id, messageId);
        return threadReceipt(linked, customerMessageView);
      } });
    return { ok: true, upload: store.view(store.row(uuid)), ...result };
  }
  function webUploadFile(request, { threadId, uuid } = {}) {
    const store = requireUploads({ write: false });
    const { thread } = webUploadScope(request, threadId, { csrf: false });
    return uploadMeta(store, uuid, thread);
  }
  // Файл — только завершённая загрузка этого чата, связанная с его сообщением (чтение — и покупателю, и владельцу).
  function uploadMeta(store, uuid, thread) {
    const meta = store.fileMeta(uuid, { targetKind: 'thread', targetId: thread.id, site: thread.site, companyCode: thread.company_code });
    const message = meta.threadMessageId ? messageRow(meta.threadMessageId) : null;
    if (!message || message.thread_id !== thread.id) fail(404, 'Файл не найден', 'NOT_FOUND');
    return meta;
  }
  function ownerPrepareUpload({ site, owner, threadId, body } = {}) {
    const store = requireUploads();
    const input = uploadKit.prepareInput(body, { maxFile: Math.min(maxFile, store.maxFile) });
    return tx(() => {
      const { who, scope } = ownerUploadScope({ site, owner, threadId });
      const { row, duplicate } = store.prepare({ scope, input,
        crossUsed: () => textRequestUsed('owner', scope.actorRef, input.requestId) || legacyOwnerUsed(who.id, input.requestId) });
      return uploadAnswer(store, row, duplicate, ownerMessageView);
    });
  }
  function ownerUploadStatus({ site, owner, threadId, uuid } = {}) {
    const store = requireUploads({ write: false });
    const { scope } = ownerUploadScope({ site, owner, threadId, write: false });
    return { ...store.status(uuid, scope, (row) => threadReceipt(row, ownerMessageView)), threadId: scope.targetId };
  }
  function ownerBeginUpload({ site, owner, threadId, uuid } = {}) {
    const store = requireUploads();
    const { scope } = ownerUploadScope({ site, owner, threadId });
    return store.begin(uuid, scope);
  }
  // owner — свежий владелец из сессии ПОСЛЕ чтения тела (server.js); проверка ownerStillValid повторяется в транзакции.
  function ownerFinishUpload({ site, owner, threadId, uuid, claim, bytes } = {}) {
    const store = requireUploads();
    let scope;
    try { ({ scope } = ownerUploadScope({ site, owner, threadId })); } catch (error) { releaseUpload(uuid, claim, 'Доступ владельца изменился'); throw error; }
    const result = store.finish({ uuid, scope, claim, bytes,
      authorize: () => { const fresh = ownerUploadScope({ site, owner, threadId }).scope; if (fresh.actorRef !== scope.actorRef) fail(403, 'Доступ владельца изменился', 'OWNER_REVOKED'); },
      receipt: (row) => threadReceipt(row, ownerMessageView),
      commit: (row) => {
        if (!uploadsOn()) fail(409, 'Отправка файлов пока недоступна — напишите текстом', 'UPLOADS_DISABLED');
        const who = requireOwner(owner);
        const thread = threadRow(row.thread_id);
        const messageId = insertMessage({ thread, direction: 'out', author: 'owner', source: 'app', text: row.caption, ownerUserId: who.id });
        const linked = store.link(row.upload_uuid, { threadMessageId: messageId, ownerSessionVersion: who.sessionVersion });
        planCustomer(thread, messageId, row.caption, null, linked);
        saveRequest('owner', scope.actorRef, who.sessionVersion, row.request_id, row.fingerprint, thread.id, messageId);
        return threadReceipt(linked, ownerMessageView);
      } });
    return { ok: true, upload: store.view(store.row(uuid)), ...result };
  }
  function ownerUploadFile({ site, owner, threadId, uuid } = {}) {
    const store = requireUploads({ write: false });
    const { thread } = ownerUploadScope({ site, owner, threadId, write: false });
    return uploadMeta(store, uuid, thread);
  }
  const openUpload = (meta) => requireUploads({ write: false }).open(meta);
  // Обрыв или отказ до чтения всего тела: приём освобождается (нужен тот же неугадываемый claim); учёт не меняется.
  const releaseUpload = (uuid, claim, reason) => { const store = uploadStore(); if (store && typeof claim === 'string' && claim) store.release(uuid, claim, reason); };

  /* Только internal capability: настройки памятки не раскрывают исходный файл чужому клиенту.
     Для конкретной заявки создаётся новая защищённая копия штатным upload journal. */
  function completionFile(owner, reference) {
    const who = requireOwner(owner), cfg = siteOf('palitra');
    if (cfg.companyCode !== 'palitra-love' || typeof reference !== 'string') fail(404, 'Файл памятки не найден', 'NOT_FOUND');
    let meta, opened, value;
    if (/^memo:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference)) {
      if (typeof readCompletionMedia !== 'function') fail(409, 'Хранилище памятки недоступно', 'MEMO_UNAVAILABLE');
      value = readCompletionMedia({ owner: who, reference });
    } else if (/^thread:[1-9]\d{0,14}$/.test(reference)) {
      const id = Number(reference.slice(7));
      const row = db.prepare('SELECT thread_id FROM chat_thread_attachments WHERE id=? AND site=? AND company_code=?').get(id, cfg.site, cfg.companyCode);
      if (!row) fail(404, 'Файл памятки не найден', 'NOT_FOUND');
      meta = ownerAttachment({ site: cfg.site, owner: who, threadId: row.thread_id, attachmentId: id });
      if (!Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > 2*1024*1024) fail(413, 'Файл памятки больше 2 МБ', 'TOO_LARGE');
      opened = openAttachment(meta);
    } else if (/^upload:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference)) {
      const uuid = reference.slice(7), store = requireUploads({ write: false }), row = store.row(uuid);
      if (!row || row.site !== cfg.site || row.company_code !== cfg.companyCode || row.target_kind !== 'thread') fail(404, 'Файл памятки не найден', 'NOT_FOUND');
      meta = ownerUploadFile({ site: cfg.site, owner: who, threadId: row.thread_id, uuid });
      if (!Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > 2*1024*1024) fail(413, 'Файл памятки больше 2 МБ', 'TOO_LARGE');
      opened = openUpload(meta);
    } else fail(400, 'Некорректная ссылка памятки', 'MEDIA_REFERENCE');
    if (opened) {
      try { value = { ...meta, bytes: fs.readFileSync(opened.fd) }; }
      finally { fs.closeSync(opened.fd); }
    }
    requireOwner(owner);
    if (!value || !Buffer.isBuffer(value.bytes) || value.bytes.length < 1 || value.bytes.length > 2*1024*1024
      || value.size !== value.bytes.length || value.sha256 !== crypto.createHash('sha256').update(value.bytes).digest('hex') || typeof value.name !== 'string')
      fail(409, 'Файл памятки изменился или недоступен', 'MEMO_CHANGED');
    const type = value.bytes.subarray(0,5).toString('ascii') === '%PDF-' ? 'application/pdf' : mediaKit.sniff(value.bytes);
    if (!['application/pdf','image/jpeg','image/png','image/webp'].includes(type)) fail(415, 'Памятка должна быть PDF или изображением', 'MEMO_TYPE');
    return { bytes: value.bytes, name: value.name, size: value.size, sha256: value.sha256 };
  }
  function validateCompletionMedia({ owner, attachmentRef } = {}) { completionFile(owner, attachmentRef); return true; }
  function completionPreparation({ owner, orderId, threadId, eventId, text, memoAttachmentRef = null } = {}) {
    const who = requireOwner(owner), direct = typeof orderId==='string' && /^thread:[1-9]\d{0,14}$/.test(orderId), id = direct ? orderId : positiveId(orderId), target = positiveId(threadId), cfg = siteOf('palitra');
    if (direct && id !== `thread:${target}`) fail(409,'Чат завершения не совпал','COMPLETION_SCOPE');
    if (!id || !target || eventId !== `workflow-issued:${id}` || cfg.companyCode !== 'palitra-love') fail(409, 'Заявка завершения не совпала', 'COMPLETION_SCOPE');
    const authorize = () => {
      requireOwner(owner);
      const rows = direct ? db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=? AND order_id IS NULL').all(target,cfg.site,cfg.companyCode) : db.prepare(`SELECT t.* FROM chat_threads t JOIN site_orders o ON o.id=t.order_id AND o.site=t.site AND o.company_code=t.company_code
        WHERE t.site=? AND t.company_code=? AND t.order_id=? LIMIT 2`).all(cfg.site,cfg.companyCode,id);
      if (rows.length !== 1 || rows[0].id !== target) fail(409, 'Чат и заявка завершения не совпали', 'COMPLETION_SCOPE');
      return rows[0];
    };
    authorize();
    const file = completionFile(who,memoAttachmentRef), store=requireUploads();
    const hex=sha256(JSON.stringify({eventId,text,memoAttachmentRef,sha256:file.sha256,name:file.name})).slice(0,32).split('');hex[12]='4';hex[16]='8';
    const h=hex.join(''),requestId=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    const scope=Object.freeze({site:cfg.site,companyCode:cfg.companyCode,botKey:botOf(cfg.site),actorKind:'owner',actorRef:`owner:${who.id}`,
      ownerSessionVersion:who.sessionVersion,targetKind:'thread',targetId:target});
    const input=uploadKit.prepareInput({requestId,name:file.name,size:file.size,sha256:file.sha256,caption:text},{maxFile:Math.min(maxFile,store.maxFile)});
    return {who,id,target,eventId,scope,input,file,store,authorize};
  }
  function prepareOrderCompletion(args = {}) {
    if (db.isTransaction === true) fail(503, 'Файл памятки готовится до транзакции этапа', 'COMPLETION_PREPARE_TRANSACTION');
    if (!args.memoAttachmentRef) return null;
    const ctx=completionPreparation(args),{who,scope,input,file,store,authorize}=ctx;
    const prepared=tx(()=>{authorize();return store.prepare({scope,input,crossUsed:()=>textRequestUsed('owner',scope.actorRef,input.requestId)||legacyOwnerUsed(who.id,input.requestId)});});
    const uuid=prepared.row.upload_uuid,started=store.begin(uuid,scope);
    store.finish({uuid,scope,claim:started.claim,bytes:file.bytes,authorize,receipt:()=>({prepared:true}),commit:()=>({prepared:true})});
    authorize();
    return Object.freeze({uuid,eventId:ctx.eventId,threadId:ctx.target,attachmentRef:args.memoAttachmentRef,
      fingerprint:prepared.row.fingerprint,sha256:file.sha256,actorRef:scope.actorRef});
  }
  function appendOrderCompletion({ owner, orderId, threadId, eventId, text, memoAttachmentRef = null, preparedCompletion = null } = {}) {
    if (db.isTransaction !== true) fail(503, 'Сообщение завершения требует общей транзакции', 'COMPLETION_TRANSACTION');
    const who = requireOwner(owner), direct = typeof orderId==='string' && /^thread:[1-9]\d{0,14}$/.test(orderId), id = direct ? orderId : positiveId(orderId), target = positiveId(threadId), cfg = siteOf('palitra');
    if (direct && id !== `thread:${target}`) fail(409,'Чат завершения не совпал','COMPLETION_SCOPE');
    if (!id || !target || (eventId !== `workflow-issued:${id}` && !(eventId === `workflow-issued:${id}:review` && memoAttachmentRef === null && preparedCompletion === null)) || cfg.companyCode !== 'palitra-love') fail(409, 'Заявка завершения не совпала', 'COMPLETION_SCOPE');
    const authorize = () => {
      requireOwner(owner);
      const rows = direct ? db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=? AND order_id IS NULL').all(target,cfg.site,cfg.companyCode) : db.prepare(`SELECT t.* FROM chat_threads t JOIN site_orders o ON o.id=t.order_id AND o.site=t.site AND o.company_code=t.company_code
        WHERE t.site=? AND t.company_code=? AND t.order_id=? LIMIT 2`).all(cfg.site,cfg.companyCode,id);
      if (rows.length !== 1 || rows[0].id !== target) fail(409, 'Чат и заявка завершения не совпали', 'COMPLETION_SCOPE');
      return rows[0];
    };
    let thread = authorize();
    if (typeof text !== 'string' || text.length > MAX_TEXT || CONTROL.test(text) || (!text.trim() && !memoAttachmentRef)) fail(400, 'Некорректное сообщение завершения', 'VALIDATION');
    const actorRef = `workflow-issued:${id}`, fingerprint = sha256(JSON.stringify({ orderId:id, threadId:target, eventId, text, memoAttachmentRef }));
    const known = replayOf('owner', actorRef, eventId, fingerprint, ownerMessageView);
    if (known) { authorize(); return { stored: true, duplicate: true, threadId: target, messageId: known.message.id, eventId }; }
    let messageId;
    if (!memoAttachmentRef) {
      messageId = insertMessage({ thread, direction: 'out', author: 'manager', source: 'app', text, automatic: true });
      authorize(); planCustomer(thread, messageId, text);
    } else {
      const {file,store,scope}=completionPreparation({owner,orderId:id,threadId:target,eventId,text,memoAttachmentRef});
      const uuid=preparedCompletion?.uuid,row=store.row(uuid);
      if (!row || !preparedCompletion || preparedCompletion.eventId!==eventId || preparedCompletion.threadId!==target
        || preparedCompletion.attachmentRef!==memoAttachmentRef || preparedCompletion.actorRef!==scope.actorRef
        || row.actor_ref!==scope.actorRef || row.site!==cfg.site || row.company_code!==cfg.companyCode || row.thread_id!==target
        || row.caption!==text || row.declared_sha256!==file.sha256 || row.fingerprint!==preparedCompletion.fingerprint
        || preparedCompletion.sha256!==file.sha256 || !['ready','committed'].includes(row.state))
        fail(409,'Готовый файл памятки не совпал с сообщением','COMPLETION_PREPARED');
      thread=authorize();
      const result = store.finish({ uuid, scope, bytes: file.bytes, authorize,
        receipt: row => ({ messageId: row.thread_message_id }),
        commit: row => {
          thread = authorize();
          const storedId = insertMessage({ thread, direction:'out', author:'manager', source:'app', text:row.caption, automatic:true });
          authorize(); const linked = store.link(uuid, { threadMessageId: storedId, ownerSessionVersion: who.sessionVersion });
          planCustomer(thread, storedId, row.caption, null, linked);
          return { messageId: storedId };
        } });
      messageId = result.messageId;
    }
    authorize();
    if (!Number.isSafeInteger(messageId) || messageRow(messageId)?.thread_id !== target) fail(503, 'Не подтверждено сообщение завершения', 'COMPLETION_RECEIPT');
    saveRequest('owner', actorRef, who.sessionVersion, eventId, fingerprint, target, messageId);
    authorize(); return { stored:true, duplicate:false, threadId:target, messageId, eventId };
  }

  /* ---------- доставки (существующая очередь и мост в phaseB) ---------- */
  /* FR-011: можно ли ещё отправлять задание (worker проверяет перед захватом каждого задания):
     - бот сайта чата сейчас включён и это тот же бот, что у задания;
     - копия менеджеру — адресат задания и есть текущий действующий менеджер этого бота;
     - копия клиенту — её канал активен и совпадает с заданием по боту, чату и id канала;
     - ответ владельца — пока автор действующий владелец той же версии сессии. */
  function deliveryAllowed(jobRef) {
    const d = typeof jobRef === 'string' && JOB_REF.test(jobRef) ? db.prepare('SELECT * FROM chat_message_deliveries WHERE job_ref=?').get(jobRef) : null;
    if (!d) return { allowed: false, reason: 'NOT_FOUND' };
    if (d.status !== 'queued') return { allowed: false, reason: 'NOT_QUEUED' };
    const message = messageRow(d.message_id);
    const thread = message ? threadRow(message.thread_id) : null;
    if (!thread) return { allowed: false, reason: 'NOT_FOUND' };
    const botKey = botOf(thread.site);
    if (!botKey) return { allowed: false, reason: 'BOT_DISABLED' };
    if (botKey !== d.bot_key) return { allowed: false, reason: 'BOT_CHANGED' };
    if (d.channel === 'manager_telegram') {
      const operator = operatorOf(botKey);
      if (!operator || operator !== d.target_chat_id) return { allowed: false, reason: 'OPERATOR_CHANGED' };
    } else {
      const channel = d.channel_id ? db.prepare('SELECT * FROM chat_thread_channels WHERE id=?').get(d.channel_id) : null;
      if (!channel || channel.status !== 'active' || channel.thread_id !== thread.id) return { allowed: false, reason: 'CHANNEL_INACTIVE' };
      if (channel.bot_key !== d.bot_key || channel.chat_id !== d.target_chat_id) return { allowed: false, reason: 'CHANNEL_CHANGED' };
    }
    if (message.author_kind === 'owner') {
      const author = ownerOfRequest(d.message_id);
      if (!author || !ownerValid(author.id, author.version)) return { allowed: false, reason: 'OWNER_REVOKED' };
    }
    // PHASED1: копия media-сообщения, после которого пришла правка, — уже не та версия: не выдаётся (новая версия — своей копией).
    if (copySourceOf(d.message_id) && superseded(d.message_id)) return { allowed: false, reason: 'SOURCE_CHANGED' };
    return { allowed: true, reason: '' };
  }
  /* PHASED1: источник copyMessage записи (для проверки заданий адаптером перед постановкой и выдачей). */
  function copySource(messageId) {
    const source = copySourceOf(positiveId(messageId));
    return source ? { botKey: source.botKey, chatId: source.chatId, messageId: source.messageId } : null;
  }
  /* PhaseB repair R1: квитанция уже подтверждённых частей БЕЗ завершения доставки (оставшиеся части ещё разрешено
     отправить повтором). Только валидные номера — в квитанцию и в карту ответов менеджера; статус не меняется
     (queued остаётся queued). Вызывает только серверный адаптер очереди в общей транзакции; по HTTP не выдаётся. */
  function recordDeliveryReceipt({ jobRef, externalMessageIds } = {}) {
    if (typeof jobRef !== 'string' || !JOB_REF.test(jobRef)) fail(404, 'Отправка не найдена', 'NOT_FOUND');
    const ids = receiptIds(externalMessageIds);
    return tx(() => {
      const d = db.prepare('SELECT * FROM chat_message_deliveries WHERE job_ref=?').get(jobRef);
      if (!d) fail(404, 'Отправка не найдена', 'NOT_FOUND');
      if (d.status === 'not_queued') fail(409, 'Это задание не было поставлено в очередь', 'NOT_QUEUED');
      const known = JSON.parse(d.receipt || '[]');
      const receipt = [...new Set([...known, ...ids])].slice(0, 20);
      const message = messageRow(d.message_id);
      if (d.channel === 'manager_telegram' && d.target_chat_id) {
        for (const id of ids) db.prepare('INSERT OR IGNORE INTO chat_manager_map(bot_key,chat_id,message_id,thread_id,chat_message_id,created_at) VALUES(?,?,?,?,?,?)')
          .run(d.bot_key, d.target_chat_id, Number(id), message.thread_id, message.id, stamp());
      }
      if (receipt.length !== known.length) db.prepare('UPDATE chat_message_deliveries SET receipt=?, updated_at=? WHERE id=?').run(JSON.stringify(receipt), stamp(), d.id);
      return { status: d.status, receiptCount: receipt.length };
    });
  }
  /* Итог отправки задания от моста. FR-013: «отправлено» — только ok:true с хотя бы одним валидным номером сообщения
     Telegram в этой квитанции; ok:true без номера — исход не подтверждён (uncertain), не успех и не повод повторять вслепую.
     Завершённое (failed/uncertain) поздний неуспех не меняет; только подтверждённый успех с номером уточняет исход.
     Статусы каналов независимы; карта ответов менеджера пишется только из валидных номеров. */
  function acknowledgeDelivery({ jobRef, ok, uncertain, error, externalMessageIds } = {}) {
    if (typeof jobRef !== 'string' || !JOB_REF.test(jobRef)) fail(404, 'Отправка не найдена', 'NOT_FOUND');
    const ids = receiptIds(externalMessageIds);
    const confirmed = ok === true && ids.length > 0;
    return tx(() => {
      const d = db.prepare('SELECT * FROM chat_message_deliveries WHERE job_ref=?').get(jobRef);
      if (!d) fail(404, 'Отправка не найдена', 'NOT_FOUND');
      if (d.status === 'not_queued') fail(409, 'Это задание не было поставлено в очередь', 'NOT_QUEUED');
      const known = JSON.parse(d.receipt || '[]');
      const receipt = [...new Set([...known, ...ids])].slice(0, 20);
      const message = messageRow(d.message_id);
      // Копии у менеджера запоминаются, как только известны валидные номера: на них он отвечает «Ответить».
      if (d.channel === 'manager_telegram' && d.target_chat_id) {
        for (const id of ids) db.prepare('INSERT OR IGNORE INTO chat_manager_map(bot_key,chat_id,message_id,thread_id,chat_message_id,created_at) VALUES(?,?,?,?,?,?)')
          .run(d.bot_key, d.target_chat_id, Number(id), message.thread_id, message.id, stamp());
      }
      const saveReceipt = () => { if (receipt.length !== known.length) db.prepare('UPDATE chat_message_deliveries SET receipt=?, updated_at=? WHERE id=?').run(JSON.stringify(receipt), stamp(), d.id); };
      if (d.status === 'sent') { saveReceipt(); return { status: 'sent', changed: false }; }
      let next;
      if (d.status === 'failed' || d.status === 'uncertain') {
        if (!confirmed) { saveReceipt(); return { status: d.status, changed: false }; }
        next = 'sent';
      } else next = confirmed ? 'sent' : ok === true || uncertain === true ? 'uncertain' : 'failed';
      const reason = next === 'sent' ? '' : ok === true ? NO_RECEIPT
        : oneLine(error || (next === 'uncertain' ? 'Исход отправки неизвестен' : 'Telegram не принял сообщение'), 300);
      db.prepare('UPDATE chat_message_deliveries SET status=?, receipt=?, reason=?, updated_at=? WHERE id=?').run(next, JSON.stringify(receipt), reason, stamp(), d.id);
      return { status: next, changed: true };
    });
  }
  /* Явная постановка в очередь копий со статусом not_queued (в очередь они не попадали — дубля быть не может). */
  function flushNotQueued({ site, limit } = {}) {
    const cfg = siteOf(site), size = limitOf(limit);
    return tx(() => {
      const rows = db.prepare(`SELECT d.*, m.thread_id, m.text, m.source_channel, m.author_kind FROM chat_message_deliveries d
        JOIN chat_thread_messages m ON m.id=d.message_id JOIN chat_threads t ON t.id=m.thread_id
        WHERE d.status='not_queued' AND t.site=? AND t.company_code=? ORDER BY d.id LIMIT ?`).all(cfg.site, cfg.companyCode, size);
      let queued = 0, waiting = 0, stopped = 0;
      const set = (id, status, values = {}) => db.prepare('UPDATE chat_message_deliveries SET status=?, job_ref=?, reason=?, bot_key=?, target_chat_id=?, updated_at=? WHERE id=?')
        .run(status, values.jobRef ?? null, oneLine(values.reason || '', 300), values.botKey ?? null, values.chatId ?? null, stamp(), id);
      for (const d of rows) {
        const thread = threadRow(d.thread_id);
        // PHASED1: копия вложения восстанавливается из сохранённого источника, а не текстом пустой подписи; прежняя версия
        // (после неё пришла правка) не ставится — у новой версии своя копия.
        const copy = copySourceOf(d.message_id);
        // PHASEE: файл с сайта или из приложения ставится тем же файловым заданием, а не текстом подписи.
        const upload = uploadOfMessage(d.message_id);
        if (copy && superseded(d.message_id)) {
          set(d.id, 'failed', { reason: 'Сообщение изменено в Telegram до отправки — копируется новая версия', botKey: d.bot_key, chatId: d.target_chat_id }); stopped += 1; continue;
        }
        if (d.channel === 'manager_telegram') {
          const { botKey, operator, reason } = managerBlock(thread.site);
          if (reason || (copy && copy.botKey !== botKey)) { set(d.id, 'not_queued', { reason: reason || 'Клиентский бот изменён', botKey, chatId: operator }); waiting += 1; continue; }
          const jobRef = callEnqueue(managerJobOf(thread, d.message_id, d.text, d.source_channel, { botKey, operator, copy, upload }));
          set(d.id, 'queued', { jobRef, botKey, chatId: operator }); queued += 1;
          continue;
        }
        const channel = db.prepare('SELECT * FROM chat_thread_channels WHERE id=?').get(d.channel_id);
        if (!channel || channel.status !== 'active') {
          set(d.id, 'failed', { reason: 'Канал Telegram клиента изменён до отправки', botKey: d.bot_key, chatId: d.target_chat_id }); stopped += 1; continue;
        }
        if (d.author_kind === 'owner') {
          const author = ownerOfRequest(d.message_id);
          if (!author || !ownerValid(author.id, author.version)) {
            set(d.id, 'failed', { reason: 'Доступ автора ответа изменился до отправки', botKey: d.bot_key, chatId: d.target_chat_id }); stopped += 1; continue;
          }
        }
        const reason = copy && copy.botKey !== channel.bot_key ? 'Клиентский бот изменён' : customerBlock(thread.site, channel);
        if (reason) { set(d.id, 'not_queued', { reason, botKey: channel.bot_key, chatId: channel.chat_id }); waiting += 1; continue; }
        // Своё сообщение клиента с сайта — с той же подписью «Вы написали на сайте», что и при обычной постановке.
        const text = d.author_kind === 'customer' && d.source_channel === 'web' ? selfBody(d.text) : d.text;
        const jobRef = callEnqueue(customerJobOf(thread, d.message_id, text, channel, { copy, upload }));
        set(d.id, 'queued', { jobRef, botKey: channel.bot_key, chatId: channel.chat_id }); queued += 1;
      }
      return { queued, waiting, stopped };
    });
  }

  return Object.freeze({
    // Server-only actor proof for notification subscriptions. resolve repeats exact origin, cookie and CSRF.
    pushActor: (request) => { const { session } = resolve(request); return Object.freeze({ kind: 'customer', id: String(session.id), company: session.company_code, origin: session.origin, sessionVersion: session.created_at }); },
    ensureWebSession, revokeWebSession, createNewOrderThread, findOwnedOrder, peekWebHistory, listMyThreads, listWebMessages, listWebConversation,
    postWebMessage, startWebConversation, provideWebContact, issueTelegramLink, claimTelegramLink, receiveTelegramCustomerMessage, receiveManagerTelegramReply,
    ownerListThreads, ownerReadThread, ownerReadConversation, ownerReply, deliveryAllowed, acknowledgeDelivery, recordDeliveryReceipt, flushNotQueued,
    // PHASED1: вложения (только серверный адаптер, мост и защищённые маршруты чтения).
    receiveTelegramEdit, replayTelegramEdit, pendingDownloads, saveAttachment, markAttachment, mediaBytes, webAttachment, ownerAttachment, openAttachment, copySource,
    // PHASEE: файл в чат сайта (HTTP покупателя, server.js владельца) и проверка общего пространства requestId.
    prepareWebUpload, webUploadStatus, beginWebUpload, finishWebUpload, webUploadFile,
    ownerPrepareUpload, ownerUploadStatus, ownerBeginUpload, ownerFinishUpload, ownerUploadFile, openUpload, releaseUpload,
    validateCompletionMedia, prepareOrderCompletion, appendOrderCompletion,
    textRequestUsed: (kind, actorRef, requestId) => textRequestUsed(kind, actorRef, requestId) });
}

module.exports = { createCustomerChat, COOKIE, SESSION_TTL, LINK_TTL, MAX_TEXT, MAX_TELEGRAM_TEXT, WEB_RATE, LINK_RATE };
