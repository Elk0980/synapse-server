'use strict';

/* Клиентский Telegram-бот компании (сейчас — только Palitra): переписка клиентов с менеджером.

   Клиент пишет боту компании. Бот копирует сообщение менеджеру (оператору) в его личный чат с ботом.
   Менеджер отвечает кнопкой «Ответить» на сообщение клиента, и бот копирует ответ клиенту от имени
   компании. Личный аккаунт менеджера клиенту не виден. Ответ без «Ответить» никуда не уходит:
   «последнему клиенту» ничего не отправляется.

   Этот модуль — хранилище и правила. Транспорт Telegram живёт в сервисе chat (ops/chat/client-bot-bridge.js):
   там токен бота, приём событий и отправка. Сюда мост приходит по внутреннему ключу службы.

   Границы:
   - таблицы client_* отдельные: общий чат проекта, его комнаты, Хью и модели их не читают;
   - компания и сайт задаются конфигурацией бота, а не содержимым сообщений;
   - ИИ здесь нет: клиенту уходят только ответы менеджера и статичные служебные тексты;
   - неизвестный исход отправки не повторяется автоматически;
   - файлы хранятся на диске службы и выдаются только владельцу через кабинет, без ссылок Telegram.
   Все поля из Telegram — недоверенные данные. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const JOB_PREFIX = 'cb:';
const MAX_TEXT = 8000;
const DEFAULT_MAX_FILE = 20 * 1024 * 1024;           // предел скачивания файлов у Bot API
const DEFAULT_MAX_STORAGE = 1024 * 1024 * 1024;       // общий предел сохранённых файлов всех клиентских ботов
const LINK_TTL = 30 * 60 * 1000;
const CODE_TTL = 10 * 60 * 1000;
const CODE_ATTEMPTS = 5;
const LEASE = 10 * 60 * 1000;
const READY_TTL = 5 * 60 * 1000;                     // подтверждение моста считается свежим 5 минут (мост шлёт его раз в минуту)
const ATTEMPTS = 3;
const HEADER_GAP = 30 * 60 * 1000;                    // шапку «кто пишет» повторяем при смене клиента или после паузы
const PART_LIMIT = 3500;
const LIST_LIMIT = 100;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i;
const SOURCE_TAG = /^[a-z0-9][a-z0-9_]{0,31}$/;
const LINK_TOKEN = /^[A-Za-z0-9_-]{16,62}$/;
const CODE_PATTERN = /^[A-Z2-9]{6,12}$/;
const TELEGRAM_ID = /^\d{1,20}$/;
const WORK_LABELS = Object.freeze({ new: 'Новая', in_work: 'В работе', done: 'Выполнена', cancelled: 'Отменена' });
// Показываем в браузере только безопасные для просмотра типы; остальное скачивается как файл.
const INLINE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'video/mp4', 'video/webm']);
const DELIVERY = new Set(['received', 'pending', 'sending', 'sent', 'uncertain', 'failed']);

const QUOTA_ERROR = 'Лимит хранилища файлов бота исчерпан: файл не сохранён, он остаётся в переписке Telegram';
const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const clip = (value, max) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
const oneLine = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
const idOf = (value) => { const text = String(value ?? ''); return TELEGRAM_ID.test(text) ? text : ''; };
const positive = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

function createClientDialogs({ db, assetsDir, siteOrders, bots = {}, now = Date.now, randomBytes = crypto.randomBytes,
  maxFile = DEFAULT_MAX_FILE, maxStorage = DEFAULT_MAX_STORAGE, linkTtlMs = LINK_TTL, codeTtlMs = CODE_TTL } = {}) {
  const storage = path.resolve(assetsDir, 'client-dialogs');
  fs.mkdirSync(storage, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_bot_operators (
      bot_key TEXT PRIMARY KEY, telegram_user_id TEXT NOT NULL, bound_at TEXT NOT NULL, code_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS client_bot_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_key TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE,
      expected_user_id TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS client_dialogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_key TEXT NOT NULL, company_code TEXT NOT NULL,
      telegram_user_id TEXT NOT NULL, chat_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', order_id INTEGER, unread INTEGER NOT NULL DEFAULT 0, last_header_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
      UNIQUE(bot_key, telegram_user_id)
    );
    -- Заявка связана не больше чем с одним диалогом: ответ на уведомление о заявке идёт однозначно.
    CREATE UNIQUE INDEX IF NOT EXISTS client_dialogs_order ON client_dialogs(bot_key, order_id) WHERE order_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS client_dialogs_recent ON client_dialogs(company_code, last_message_at, id);
    CREATE TABLE IF NOT EXISTS client_dialog_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dialog_id INTEGER NOT NULL REFERENCES client_dialogs(id),
      bot_key TEXT NOT NULL, company_code TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out','system')),
      author_type TEXT NOT NULL CHECK(author_type IN ('client','operator','system')),
      text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, telegram_date INTEGER,
      chat_id TEXT, message_id INTEGER, delivery_status TEXT NOT NULL DEFAULT 'received',
      delivery_error TEXT NOT NULL DEFAULT '', delivered_message_id INTEGER, edited INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_key, chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS client_dialog_messages_dialog ON client_dialog_messages(dialog_id, id);
    CREATE TABLE IF NOT EXISTS client_dialog_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES client_dialog_messages(id),
      text TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('client_edit','operator_edit_not_sent')),
      edit_date INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(message_id, kind, edit_date)
    );
    CREATE TABLE IF NOT EXISTS client_dialog_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES client_dialog_messages(id),
      dialog_id INTEGER NOT NULL, bot_key TEXT NOT NULL, company_code TEXT NOT NULL,
      kind TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL, size INTEGER,
      file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','stored','too_large','unavailable','quota_exceeded')),
      disk_name TEXT, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, stored_at TEXT, superseded_at TEXT
    );
    -- Свежее подтверждение моста: chat проверил токен (getMe) и имя бота. Без него ссылки в Telegram не выдаются.
    CREATE TABLE IF NOT EXISTS client_bot_bridge_state (
      bot_key TEXT PRIMARY KEY, ok INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '', telegram_bot_id TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS client_dialog_attachments_message ON client_dialog_attachments(message_id);
    CREATE TABLE IF NOT EXISTS client_bot_receipts (
      bot_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, edit_date INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(bot_key, chat_id, message_id, edit_date)
    );
    CREATE TABLE IF NOT EXISTS client_bot_map (
      bot_key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      dialog_id INTEGER, client_message_id INTEGER, order_id INTEGER, created_at TEXT NOT NULL,
      PRIMARY KEY(bot_key, chat_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS client_bot_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_key TEXT NOT NULL, company_code TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('forward','reply','notice')), dialog_id INTEGER, message_id INTEGER,
      reply_to_operator_message INTEGER, operator_id TEXT, parts TEXT NOT NULL, after TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, next_attempt_at TEXT NOT NULL,
      external_ids TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS client_bot_outbox_pending ON client_bot_outbox(bot_key, status, id);
    CREATE TABLE IF NOT EXISTS client_order_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_key TEXT NOT NULL, site TEXT NOT NULL, order_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, dialog_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS client_bot_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_key TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
  `);

  // Колонка менеджера у заданий: к базе, созданной первой версией модуля, добавляется без пересоздания.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('client_bot_outbox') WHERE name='operator_id'").get()) {
    db.exec('ALTER TABLE client_bot_outbox ADD COLUMN operator_id TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('client_dialog_attachments') WHERE name='superseded_at'").get()) {
    db.exec('ALTER TABLE client_dialog_attachments ADD COLUMN superseded_at TEXT');
  }
  const stamp = (at = now()) => new Date(at).toISOString();
  let inTx = false;
  const tx = (fn) => {
    if (inTx) return fn();
    db.exec('BEGIN IMMEDIATE'); inTx = true;
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { inTx = false; }
  };

  /* ---------- конфигурация ---------- */
  // Бот считается включённым в content, только если задано его имя (не секрет). Токен живёт только в chat.
  const config = (key) => {
    const bot = Object.hasOwn(bots, key) ? bots[key] : null;
    return bot && USERNAME.test(String(bot.username || '')) ? bot : null;
  };
  const requireBot = (key) => config(key) || fail(404, 'Клиентский бот не подключён', 'BOT_DISABLED');
  const botForSite = (site) => {
    for (const [key, bot] of Object.entries(bots)) if (bot && bot.site === site) return { key, bot, enabled: Boolean(config(key)) };
    return null;
  };
  const audit = (key, kind, actor, detail) => db.prepare('INSERT INTO client_bot_audit(bot_key,kind,actor,detail,created_at) VALUES(?,?,?,?,?)')
    .run(key, kind, oneLine(actor, 80), oneLine(detail, 300), stamp());
  const operatorOf = (key) => db.prepare('SELECT * FROM client_bot_operators WHERE bot_key=?').get(key) || null;
  /* Действующий менеджер — привязанный, чей Telegram ID совпадает с текущим получателем заявок.
     После смены получателя прежний менеджер больше ничего не получает и не может отвечать клиентам. */
  const activeOperator = (key) => {
    const operator = operatorOf(key);
    const bot = Object.hasOwn(bots, key) ? bots[key] : null;
    if (!operator || !bot) return null;
    const recipient = siteOrders.recipientStatus(bot.site);
    return recipient.configured && recipient.telegramChatId === operator.telegram_user_id ? operator : null;
  };
  /* Остановить ещё не начатые задания, связанные с прежним менеджером: копии ему, заметки ему и его ответы клиентам.
     Уже начатые (sending) не трогаются: их исход придёт подтверждением или станет «неизвестен» по сроку аренды. */
  function stopOperatorJobs(key, operatorId, reason) {
    const rows = db.prepare("SELECT id,message_id FROM client_bot_outbox WHERE bot_key=? AND status='pending' AND operator_id=?").all(key, String(operatorId));
    const at = stamp();
    for (const row of rows) {
      db.prepare("UPDATE client_bot_outbox SET status='failed',error=?,claimed_at=NULL,finished_at=? WHERE id=?").run(reason, at, row.id);
      if (row.message_id) db.prepare("UPDATE client_dialog_messages SET delivery_status='failed',delivery_error=? WHERE id=?").run(reason, row.message_id);
    }
    if (rows.length) audit(key, 'operator_jobs_stopped', 'system', `${reason}: ${rows.length}`);
    return rows.length;
  }
  /* Подтверждение моста: chat присылает результат getMe. Готов только свежий успешный ответ с тем же именем бота. */
  function heartbeat(key, body = {}) {
    const bot = requireBot(key);
    const username = String(body.username || '').replace(/^@/, '');
    const ok = body.ok === true && username.toLowerCase() === String(bot.username).toLowerCase();
    const error = ok ? '' : oneLine(body.error || (body.ok === true ? `Токен относится к боту @${username}, а не @${bot.username}` : 'Мост не подтвердил бота'), 200);
    db.prepare(`INSERT INTO client_bot_bridge_state(bot_key,ok,username,telegram_bot_id,error,checked_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(bot_key) DO UPDATE SET ok=excluded.ok,username=excluded.username,telegram_bot_id=excluded.telegram_bot_id,error=excluded.error,checked_at=excluded.checked_at`)
      .run(key, ok ? 1 : 0, oneLine(username, 64), idOf(body.botId), error, stamp());
    return { ok, error };
  }
  const bridgeState = (key) => {
    const bot = config(key);
    const row = db.prepare('SELECT * FROM client_bot_bridge_state WHERE bot_key=?').get(key);
    if (!bot || !row) return { ready: false, checkedAt: null, error: row?.error || 'Мост ещё не подтверждал бота' };
    const fresh = now() - Date.parse(row.checked_at) <= READY_TTL;
    const ready = Boolean(row.ok) && fresh && row.username.toLowerCase() === String(bot.username).toLowerCase();
    return { ready, checkedAt: row.checked_at, error: ready ? '' : (!fresh ? 'Нет свежего подтверждения от сервиса chat' : row.error || 'Мост не подтвердил бота') };
  };
  const storageUsed = () => Number(db.prepare("SELECT COALESCE(sum(size),0) AS n FROM client_dialog_attachments WHERE status='stored'").get().n);

  const greeting = (bot, extra = '') => [
    `Здравствуйте! Это ${bot.title}.`,
    'Напишите, что хотите заказать или уточнить, — менеджер ответит здесь.',
    bot.hours ? `Отвечаем ежедневно ${bot.hours}.` : '',
    extra,
    `Ваши обращения и переписка сохраняются, чтобы обработать заказ.${bot.policyUrl ? ` Политика обработки данных: ${bot.policyUrl}` : ''}`,
  ].filter(Boolean).join('\n');

  /* ---------- очередь отправки ---------- */
  const chunks = (text) => {
    const value = String(text || '');
    const parts = [];
    for (let start = 0; start < value.length; start += PART_LIMIT) parts.push(value.slice(start, start + PART_LIMIT));
    return parts.length ? parts : [''];
  };
  function enqueue(key, bot, kind, { parts, after = [], dialogId = null, messageId = null, replyToOperatorMessage = null, operatorId = null }) {
    const at = stamp();
    return Number(db.prepare(`INSERT INTO client_bot_outbox(bot_key,company_code,kind,dialog_id,message_id,reply_to_operator_message,operator_id,parts,after,next_attempt_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(key, bot.companyCode, kind, dialogId, messageId, replyToOperatorMessage, operatorId,
      JSON.stringify(parts), JSON.stringify(after), at, at).lastInsertRowid);
  }
  const textParts = (chatId, text, { replyTo = null, map = null } = {}) => chunks(text).map((part, index) => ({
    method: 'sendMessage',
    params: { chat_id: chatId, text: part, ...(replyTo && index === 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) },
    ...(map ? { map } : {}) }));
  function notice(key, bot, chatId, text, { replyTo = null, dialogId = null, messageId = null, map = null } = {}) {
    // Заметка действующему менеджеру помечается им: при смене менеджера она не уйдёт прежнему.
    const operatorId = activeOperator(key)?.telegram_user_id === String(chatId) ? String(chatId) : null;
    return enqueue(key, bot, 'notice', { parts: textParts(chatId, text, { replyTo, map }), dialogId, messageId, operatorId });
  }
  /* Служебный текст клиенту сохраняется в диалоге: в кабинете видно всё, что клиент получил от бота. */
  function clientNotice(key, bot, dialog, text) {
    const id = insertMessage({ dialog, direction: 'out', authorType: 'system', text, chatId: null, messageId: null, status: 'pending' });
    notice(key, bot, dialog.chat_id, text, { dialogId: dialog.id, messageId: id });
    return id;
  }

  /* ---------- хранение ---------- */
  function insertMessage({ dialog, direction, authorType, text, chatId, messageId, telegramDate = null, status = 'received' }) {
    const at = stamp();
    const id = Number(db.prepare(`INSERT INTO client_dialog_messages(dialog_id,bot_key,company_code,direction,author_type,text,created_at,telegram_date,chat_id,message_id,delivery_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(dialog.id, dialog.bot_key, dialog.company_code, direction, authorType, clip(text, MAX_TEXT), at,
      telegramDate, chatId, messageId, status).lastInsertRowid);
    db.prepare('UPDATE client_dialogs SET updated_at=?,last_message_at=? WHERE id=?').run(at, at, dialog.id);
    return id;
  }
  function upsertDialog(key, bot, from, chatId) {
    const userId = idOf(from?.id);
    const name = oneLine([from?.first_name, from?.last_name].filter(Boolean).join(' '), 120) || 'Клиент Telegram';
    const username = /^[A-Za-z0-9_]{1,32}$/.test(String(from?.username || '')) ? String(from.username) : '';
    const at = stamp();
    // Сначала поиск, потом вставка: номер диалога виден менеджеру и не должен «прыгать» от повторных обновлений.
    const existing = db.prepare('SELECT id FROM client_dialogs WHERE bot_key=? AND telegram_user_id=?').get(key, userId);
    if (existing) db.prepare('UPDATE client_dialogs SET display_name=?,username=?,chat_id=? WHERE id=?').run(name, username, chatId, existing.id);
    else db.prepare(`INSERT INTO client_dialogs(bot_key,company_code,telegram_user_id,chat_id,display_name,username,created_at,updated_at,last_message_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(key, bot.companyCode, userId, chatId, name, username, at, at, at);
    return db.prepare('SELECT * FROM client_dialogs WHERE bot_key=? AND telegram_user_id=?').get(key, userId);
  }
  /* Одно вложение на сообщение (альбом Telegram приходит отдельными сообщениями). Фото — самый крупный
     размер, который помещается в предел; остальное — как есть. Размер больше предела — сразу «слишком большой». */
  function mediaOf(message) {
    const id = message.message_id;
    if (Array.isArray(message.photo) && message.photo.length) {
      const sizes = message.photo.filter((item) => item && typeof item.file_id === 'string');
      const fitting = sizes.filter((item) => !positive(item.file_size) || item.file_size <= maxFile);
      const photo = (fitting.length ? fitting : sizes).at(-1);
      return photo && { kind: 'photo', item: photo, mime: 'image/jpeg', name: `photo-${id}.jpg` };
    }
    const pick = (field, kind, fallbackMime, fallbackName) => {
      const item = message[field];
      if (!item || typeof item.file_id !== 'string') return null;
      const mime = /^[a-z]+\/[a-z0-9.+-]{1,80}$/i.test(String(item.mime_type || '')) ? String(item.mime_type).toLowerCase() : fallbackMime;
      const name = oneLine(item.file_name, 180).replace(/[\\/]/g, '_') || fallbackName;
      return { kind, item, mime, name };
    };
    return pick('voice', 'voice', 'audio/ogg', `voice-${id}.ogg`) || pick('audio', 'audio', 'audio/mpeg', `audio-${id}.mp3`)
      || pick('video', 'video', 'video/mp4', `video-${id}.mp4`) || pick('video_note', 'video_note', 'video/mp4', `video-note-${id}.mp4`)
      || pick('animation', 'animation', 'video/mp4', `animation-${id}.mp4`) || pick('document', 'document', 'application/octet-stream', `file-${id}`)
      || pick('sticker', 'sticker', 'image/webp', `sticker-${id}.webp`);
  }
  function messageText(message) {
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    if (text) return text;
    if (message.contact) return `Контакт: ${oneLine([message.contact.first_name, message.contact.last_name].filter(Boolean).join(' '), 120)} ${oneLine(message.contact.phone_number, 32)}`.trim();
    if (message.location) return `Геопозиция: ${Number(message.location.latitude)}, ${Number(message.location.longitude)}`;
    return '';
  }
  function storeAttachment(dialog, messageId, message) {
    const media = mediaOf(message);
    if (!media) return null;
    const size = positive(media.item.file_size) || null;
    const used = storageUsed();
    // Размер известен заранее — лимиты проверяются до скачивания; неизвестен — окончательно при сохранении.
    const status = size && size > maxFile ? 'too_large' : (size ? used + size > maxStorage : used >= maxStorage) ? 'quota_exceeded' : 'pending';
    const error = status === 'too_large' ? `Файл больше ${Math.round(maxFile / 1024 / 1024)} МБ: сохранены только сведения о нём`
      : status === 'quota_exceeded' ? QUOTA_ERROR : '';
    return Number(db.prepare(`INSERT INTO client_dialog_attachments(message_id,dialog_id,bot_key,company_code,kind,mime,name,size,file_id,file_unique_id,status,error,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, dialog.id, dialog.bot_key, dialog.company_code, media.kind, media.mime, media.name, size,
      String(media.item.file_id).slice(0, 300), oneLine(media.item.file_unique_id, 120), status, error, stamp()).lastInsertRowid);
  }
  const pendingDownloads = (messageIds) => (messageIds.length ? db.prepare(`SELECT id,file_id,size FROM client_dialog_attachments
    WHERE status='pending' AND superseded_at IS NULL AND message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY id`).all(...messageIds) : [])
    .map((row) => ({ attachmentId: row.id, fileId: row.file_id, size: row.size }));

  /* ---------- шапка «кто пишет» и копия менеджеру ---------- */
  const lastForwardedDialog = (key) => db.prepare(`SELECT dialog_id FROM client_bot_outbox WHERE bot_key=? AND kind='forward' ORDER BY id DESC LIMIT 1`).get(key)?.dialog_id ?? null;
  function header(dialog, prefix = '💬') {
    const parts = [`${prefix} ${dialog.display_name}${dialog.username ? ` (@${dialog.username})` : ''}`, `диалог №${dialog.id}`];
    if (dialog.order_id) parts.push(`заявка №${dialog.order_id}`);
    if (dialog.source) parts.push(`источник: ${dialog.source}`);
    return parts.join(' · ');
  }
  function forward(key, bot, operator, dialog, messageRowId, clientMessageId) {
    const parts = [];
    const due = !dialog.last_header_at || now() - Date.parse(dialog.last_header_at) >= HEADER_GAP || lastForwardedDialog(key) !== dialog.id;
    if (due) {
      parts.push(...textParts(operator.telegram_user_id, header(dialog), { map: 'dialog' }));
      db.prepare('UPDATE client_dialogs SET last_header_at=? WHERE id=?').run(stamp(), dialog.id);
    }
    parts.push({ method: 'copyMessage', params: { chat_id: operator.telegram_user_id, from_chat_id: dialog.chat_id, message_id: clientMessageId }, map: 'message' });
    db.prepare("UPDATE client_dialog_messages SET delivery_status='pending' WHERE id=?").run(messageRowId);
    return enqueue(key, bot, 'forward', { parts, dialogId: dialog.id, messageId: messageRowId, operatorId: operator.telegram_user_id });
  }

  /* ---------- приём событий моста ---------- */
  function receive(key, update) {
    const bot = requireBot(key);
    const message = update?.message || update?.edited_message;
    const edited = Boolean(update?.edited_message) && !update?.message;
    if (!message || typeof message !== 'object') fail(400, 'Некорректное событие', 'VALIDATION');
    const chatId = idOf(message.chat?.id), fromId = idOf(message.from?.id), messageId = positive(message.message_id);
    // Только личный чат человека с ботом: в личке chat.id совпадает с from.id. Группы и каналы сюда не попадают.
    if (message.chat?.type !== 'private' || !chatId || !messageId || fromId !== chatId) fail(422, 'Принимаются только личные сообщения', 'NOT_PRIVATE');
    if (message.from?.is_bot) return { ok: true, ignored: true, downloads: [] };
    const editDate = edited ? positive(message.edit_date) || 1 : 0;
    const known = db.prepare('SELECT result FROM client_bot_receipts WHERE bot_key=? AND chat_id=? AND message_id=? AND edit_date=?').get(key, chatId, messageId, editDate);
    if (known) {
      const result = JSON.parse(known.result);
      return { ...result, duplicate: true, downloads: pendingDownloads(result.messageIds || []) };
    }
    const result = tx(() => {
      const value = edited ? receiveEdit(key, bot, message, chatId, messageId, editDate) : receiveMessage(key, bot, message, chatId, messageId);
      db.prepare('INSERT INTO client_bot_receipts(bot_key,chat_id,message_id,edit_date,result,created_at) VALUES(?,?,?,?,?,?)')
        .run(key, chatId, messageId, editDate, JSON.stringify(value), stamp());
      return value;
    });
    return { ...result, duplicate: false, downloads: pendingDownloads(result.messageIds || []) };
  }

  const command = (text) => {
    const match = /^\/([A-Za-zА-Яа-яЁё_]+)(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/u.exec(String(text || '').trim());
    return match ? { name: match[1].toLowerCase(), arg: String(match[2] || '').trim() } : null;
  };

  function receiveMessage(key, bot, message, chatId, messageId) {
    const text = messageText(message);
    const cmd = command(text);
    const operator = activeOperator(key);
    const isOperator = Boolean(operator && operator.telegram_user_id === chatId);
    if (cmd && ((cmd.name === 'start' && /^op_/.test(cmd.arg)) || cmd.name === 'operator')) {
      return bindOperator(key, bot, chatId, cmd.name === 'operator' ? cmd.arg : cmd.arg.slice(3));
    }
    if (isOperator) return operatorMessage(key, bot, operator, message, chatId, messageId, text, cmd);
    // Прежний менеджер после смены получателя: ни его сообщений клиентам, ни копий ему — только объяснение.
    const stale = operatorOf(key);
    if (stale && stale.telegram_user_id === chatId) {
      audit(key, 'operator_inactive', `telegram:${chatId}`, 'получатель заявок изменён');
      notice(key, bot, chatId, 'Вы больше не подключены как менеджер: получатель заявок изменён. Сообщение клиенту не отправлено.', { replyTo: messageId });
      return { ok: true, action: 'operator_inactive', messageIds: [] };
    }
    return clientMessage(key, bot, operator, message, chatId, messageId, text, cmd);
  }

  /* Привязка менеджера: одноразовый код владельца, короткий срок и строгое совпадение с ожидаемым Telegram ID
     получателя заявок. Чужой пользователь с верным кодом не привязывается; ответ не раскрывает причину. */
  function bindOperator(key, bot, chatId, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    const refuse = (reason) => {
      audit(key, 'operator_bind_refused', `telegram:${chatId}`, reason);
      notice(key, bot, chatId, 'Код не подошёл или устарел. Попросите владельца создать новый код в личном кабинете.');
      return { ok: true, action: 'bind_refused', messageIds: [] };
    };
    if (!CODE_PATTERN.test(code)) return refuse('формат');
    const row = db.prepare('SELECT * FROM client_bot_codes WHERE bot_key=? AND code_hash=?').get(key, sha256(`${key}:${code}`));
    if (!row || row.used_at || Date.parse(row.expires_at) <= now()) return refuse('нет действующего кода');
    if (row.expected_user_id !== chatId) {
      const attempts = row.failed_attempts + 1;
      db.prepare('UPDATE client_bot_codes SET failed_attempts=?,expires_at=CASE WHEN ?>=? THEN ? ELSE expires_at END WHERE id=?')
        .run(attempts, attempts, CODE_ATTEMPTS, stamp(), row.id);
      return refuse('другой Telegram ID');
    }
    // Код действует только для текущего получателя: после смены получателя старый код гасится.
    const recipient = siteOrders.recipientStatus(bot.site);
    if (!recipient.configured || recipient.telegramChatId !== row.expected_user_id) {
      db.prepare('UPDATE client_bot_codes SET expires_at=? WHERE id=?').run(stamp(), row.id);
      return refuse('получатель заявок изменён после создания кода');
    }
    const at = stamp();
    const previous = operatorOf(key);
    // Новый менеджер: ещё не начатые задания прежнему (копии, заметки, его ответы) останавливаются.
    if (previous && previous.telegram_user_id !== chatId) stopOperatorJobs(key, previous.telegram_user_id, 'Менеджер заменён до отправки');
    db.prepare('UPDATE client_bot_codes SET used_at=? WHERE id=?').run(at, row.id);
    db.prepare(`INSERT INTO client_bot_operators(bot_key,telegram_user_id,bound_at,code_id) VALUES(?,?,?,?)
      ON CONFLICT(bot_key) DO UPDATE SET telegram_user_id=excluded.telegram_user_id,bound_at=excluded.bound_at,code_id=excluded.code_id`).run(key, chatId, at, row.id);
    audit(key, 'operator_bound', `telegram:${chatId}`, previous && previous.telegram_user_id !== chatId ? `заменён прежний оператор ${previous.telegram_user_id}` : 'подключён');
    notice(key, bot, chatId, [
      `Готово: вы подключены как менеджер ${bot.title}.`,
      'Сообщения клиентов будут приходить сюда. Чтобы ответить клиенту, нажмите «Ответить» на его сообщении — ответ уйдёт от имени бота.',
      'Сообщение без «Ответить» клиенту не отправляется.',
    ].join('\n'));
    return { ok: true, action: 'operator_bound', messageIds: [] };
  }

  function clientMessage(key, bot, operator, message, chatId, messageId, text, cmd) {
    let dialog = upsertDialog(key, bot, message.from, chatId);
    if (cmd && cmd.name === 'start') {
      const payload = cmd.arg;
      let extra = '', linkedOrder = null;
      if (/^o_/.test(payload)) {
        linkedOrder = linkOrder(key, bot, dialog, payload.slice(2));
        extra = linkedOrder ? `Ваша заявка №${linkedOrder} уже у менеджера — продолжим здесь.`
          : 'Ссылка на заявку устарела. Просто напишите сюда — менеджер ответит.';
      } else if (payload && SOURCE_TAG.test(payload) && !payload.startsWith('op') && !dialog.source) {
        db.prepare('UPDATE client_dialogs SET source=? WHERE id=?').run(payload, dialog.id);
      }
      dialog = db.prepare('SELECT * FROM client_dialogs WHERE id=?').get(dialog.id);
      const event = ['Клиент открыл бота', dialog.source ? `источник: ${dialog.source}` : '', linkedOrder ? `связан с заявкой №${linkedOrder}` : '']
        .filter(Boolean).join(' · ');
      insertMessage({ dialog, direction: 'system', authorType: 'system', text: event, chatId: null, messageId: null });
      clientNotice(key, bot, dialog, greeting(bot, extra));
      if (operator) {
        enqueue(key, bot, 'forward', { parts: textParts(operator.telegram_user_id, header(dialog, '🆕 Новый диалог:'), { map: 'dialog' }), dialogId: dialog.id,
          operatorId: operator.telegram_user_id });
        db.prepare('UPDATE client_dialogs SET last_header_at=? WHERE id=?').run(stamp(), dialog.id);
      }
      return { ok: true, action: 'start', dialogId: dialog.id, messageIds: [] };
    }
    const row = insertMessage({ dialog, direction: 'in', authorType: 'client', text, chatId, messageId, telegramDate: positive(message.date) || null });
    storeAttachment(dialog, row, message);
    db.prepare('UPDATE client_dialogs SET unread=unread+1 WHERE id=?').run(dialog.id);
    // Без менеджера сообщение сохраняется и видно владельцу; в Telegram его никто не получает.
    if (operator) forward(key, bot, operator, db.prepare('SELECT * FROM client_dialogs WHERE id=?').get(dialog.id), row, messageId);
    return { ok: true, action: operator ? 'forwarded' : 'stored', dialogId: dialog.id, messageIds: [row] };
  }

  function linkOrder(key, bot, dialog, token) {
    if (!LINK_TOKEN.test(token)) { audit(key, 'order_link_refused', `telegram:${dialog.telegram_user_id}`, 'формат'); return null; }
    const row = db.prepare('SELECT * FROM client_order_links WHERE bot_key=? AND token_hash=?').get(key, sha256(token));
    if (!row || row.used_at || Date.parse(row.expires_at) <= now() || row.site !== bot.site) {
      audit(key, 'order_link_refused', `telegram:${dialog.telegram_user_id}`, row ? (row.used_at ? 'ссылка уже использована' : 'срок истёк') : 'нет такой ссылки');
      return null;
    }
    const other = db.prepare('SELECT id FROM client_dialogs WHERE bot_key=? AND order_id=? AND id<>?').get(key, row.order_id, dialog.id);
    db.prepare('UPDATE client_order_links SET used_at=?,dialog_id=? WHERE id=?').run(stamp(), dialog.id, row.id);
    // Заявка уже связана с другим диалогом: вторую связь не создаём, ссылка гасится.
    if (other) { audit(key, 'order_link_refused', `telegram:${dialog.telegram_user_id}`, `заявка №${row.order_id} уже связана с диалогом №${other.id}`); return null; }
    db.prepare('UPDATE client_dialogs SET order_id=? WHERE id=?').run(row.order_id, dialog.id);
    audit(key, 'order_linked', `telegram:${dialog.telegram_user_id}`, `диалог №${dialog.id} ↔ заявка №${row.order_id} (ссылка)`);
    return row.order_id;
  }

  const mapOf = (key, chatId, messageId) => db.prepare('SELECT * FROM client_bot_map WHERE bot_key=? AND chat_id=? AND message_id=?').get(key, chatId, messageId) || null;

  function operatorMessage(key, bot, operator, message, chatId, messageId, text, cmd) {
    const opChat = operator.telegram_user_id;
    const say = (value) => notice(key, bot, opChat, value, { replyTo: messageId });
    const replyTo = positive(message.reply_to_message?.message_id);
    const target = replyTo ? mapOf(key, opChat, replyTo) : null;
    if (cmd) {
      if (cmd.name === 'start') {
        say(`Вы подключены как менеджер ${bot.title}. Чтобы ответить клиенту, нажмите «Ответить» на его сообщении.`);
        return { ok: true, action: 'operator_help', messageIds: [] };
      }
      if (['заявка', 'order'].includes(cmd.name)) return manualLink(key, bot, target, cmd.arg, say);
      if (['отвязать', 'unlink'].includes(cmd.name)) return unlinkOrder(key, target, say);
      // Прочие команды клиенту не отправляются: это не текст для клиента.
      say('Команды клиенту не отправляются. Чтобы ответить, нажмите «Ответить» на сообщении клиента и напишите текст.');
      return { ok: true, action: 'operator_command_ignored', messageIds: [] };
    }
    if (!replyTo) {
      audit(key, 'operator_unrouted', `telegram:${opChat}`, 'нет «Ответить»');
      say('Это сообщение не отправлено клиенту. Нажмите «Ответить» на сообщении клиента — тогда ответ уйдёт нужному человеку.');
      return { ok: true, action: 'operator_unrouted', messageIds: [] };
    }
    let dialog = target?.dialog_id ? db.prepare('SELECT * FROM client_dialogs WHERE id=? AND bot_key=?').get(target.dialog_id, key) : null;
    if (!dialog && target?.order_id) {
      // Ответ на уведомление о заявке идёт только единственному связанному диалогу; «последнего клиента» не выбираем.
      const linked = db.prepare('SELECT * FROM client_dialogs WHERE bot_key=? AND order_id=?').all(key, target.order_id);
      if (linked.length !== 1) {
        say(linked.length ? `Заявка №${target.order_id} связана с несколькими диалогами — ответьте на сообщение нужного клиента.`
          : `По заявке №${target.order_id} клиент ещё не писал в этот бот, поэтому ответить здесь нельзя. Свяжитесь по телефону из заявки.`);
        return { ok: true, action: linked.length ? 'order_ambiguous' : 'order_without_dialog', messageIds: [] };
      }
      dialog = linked[0];
    }
    if (!dialog) {
      audit(key, 'operator_unrouted', `telegram:${opChat}`, 'ответ на неизвестное сообщение');
      say('Не удалось определить клиента. Нажмите «Ответить» на сообщении клиента, которое переслал бот.');
      return { ok: true, action: 'operator_unrouted', messageIds: [] };
    }
    const row = insertMessage({ dialog, direction: 'out', authorType: 'operator', text, chatId: opChat, messageId,
      telegramDate: positive(message.date) || null, status: 'pending' });
    storeAttachment(dialog, row, message);
    db.prepare('UPDATE client_dialogs SET unread=0 WHERE id=?').run(dialog.id);
    enqueue(key, bot, 'reply', {
      parts: [{ method: 'copyMessage', params: { chat_id: dialog.chat_id, from_chat_id: opChat, message_id: messageId } }],
      after: [{ method: 'setMessageReaction', params: { chat_id: opChat, message_id: messageId, reaction: [{ type: 'emoji', emoji: '👌' }] } }],
      dialogId: dialog.id, messageId: row, replyToOperatorMessage: messageId, operatorId: opChat });
    return { ok: true, action: 'reply', dialogId: dialog.id, messageIds: [row] };
  }

  /* Ручная связь диалога с заявкой: менеджер отвечает на сообщение клиента командой «/заявка 12». */
  function manualLink(key, bot, target, arg, say) {
    const orderId = Number(String(arg || '').replace(/^№/, ''));
    if (!target?.dialog_id || !Number.isSafeInteger(orderId) || orderId < 1) {
      say('Чтобы связать клиента с заявкой, ответьте на его сообщение командой «/заявка номер», например /заявка 12.');
      return { ok: true, action: 'manual_link_refused', messageIds: [] };
    }
    const order = siteOrders.orderSummary(bot.site, orderId);
    if (!order) { say(`Заявка №${orderId} не найдена.`); return { ok: true, action: 'manual_link_refused', messageIds: [] }; }
    // Одна заявка — один диалог. Перенос только явно: сначала «/отвязать» в прежнем диалоге.
    const other = db.prepare('SELECT id FROM client_dialogs WHERE bot_key=? AND order_id=? AND id<>?').get(key, orderId, target.dialog_id);
    if (other) {
      audit(key, 'order_link_refused', 'operator', `заявка №${orderId} уже связана с диалогом №${other.id}`);
      say(`Заявка №${orderId} уже связана с диалогом №${other.id}. Чтобы перенести, ответьте на сообщение того клиента командой /отвязать, затем повторите.`);
      return { ok: true, action: 'manual_link_conflict', messageIds: [] };
    }
    db.prepare('UPDATE client_dialogs SET order_id=? WHERE id=? AND bot_key=?').run(orderId, target.dialog_id, key);
    audit(key, 'order_linked', 'operator', `диалог №${target.dialog_id} ↔ заявка №${orderId} (вручную)`);
    say(`Диалог №${target.dialog_id} связан с заявкой №${orderId}.`);
    return { ok: true, action: 'manual_link', dialogId: target.dialog_id, messageIds: [] };
  }

  /* Отвязать заявку от диалога: менеджер отвечает на сообщение клиента командой «/отвязать». */
  function unlinkOrder(key, target, say) {
    const dialog = target?.dialog_id ? db.prepare('SELECT * FROM client_dialogs WHERE id=? AND bot_key=?').get(target.dialog_id, key) : null;
    if (!dialog?.order_id) {
      say('Чтобы отвязать заявку, ответьте командой /отвязать на сообщение клиента, у которого есть связанная заявка.');
      return { ok: true, action: 'unlink_refused', messageIds: [] };
    }
    db.prepare('UPDATE client_dialogs SET order_id=NULL WHERE id=?').run(dialog.id);
    audit(key, 'order_unlinked', 'operator', `диалог №${dialog.id} ↛ заявка №${dialog.order_id}`);
    say(`Заявка №${dialog.order_id} отвязана от диалога №${dialog.id}.`);
    return { ok: true, action: 'unlink', dialogId: dialog.id, messageIds: [] };
  }

  /* Правки: клиентская сохраняется версией и показывается менеджеру; правка менеджера клиенту не уходит —
     Telegram не переносит правки в копию, поэтому честно сообщаем об этом. */
  function receiveEdit(key, bot, message, chatId, messageId, editDate) {
    const row = db.prepare('SELECT * FROM client_dialog_messages WHERE bot_key=? AND chat_id=? AND message_id=?').get(key, chatId, messageId);
    if (!row) return { ok: true, action: 'edit_ignored', messageIds: [] };
    const text = clip(messageText(message), MAX_TEXT);
    const operator = activeOperator(key);
    if (row.author_type === 'client') {
      const dialog = db.prepare('SELECT * FROM client_dialogs WHERE id=?').get(row.dialog_id);
      db.prepare('INSERT OR IGNORE INTO client_dialog_versions(message_id,text,kind,edit_date,created_at) VALUES(?,?,?,?,?)').run(row.id, row.text, 'client_edit', editDate, stamp());
      db.prepare('UPDATE client_dialog_messages SET text=?,edited=1 WHERE id=?').run(text, row.id);
      // Клиент заменил фото или видео: прежнее вложение помечается заменённым (файл не выдаётся за новый),
      // новое сохраняется отдельной строкой по тем же правилам и лимитам.
      const media = mediaOf(message);
      const current = db.prepare('SELECT * FROM client_dialog_attachments WHERE message_id=? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1').get(row.id);
      const replaced = Boolean(media) && (!current || (current.file_unique_id || current.file_id) !== (oneLine(media.item.file_unique_id, 120) || String(media.item.file_id)));
      if (replaced) {
        if (current) db.prepare('UPDATE client_dialog_attachments SET superseded_at=? WHERE id=?').run(stamp(), current.id);
        storeAttachment(dialog, row.id, message);
      }
      if (operator) {
        const copy = db.prepare('SELECT message_id FROM client_bot_map WHERE bot_key=? AND client_message_id=? AND chat_id=? ORDER BY created_at DESC LIMIT 1').get(key, row.id, operator.telegram_user_id);
        const parts = textParts(operator.telegram_user_id, `✏️ ${dialog.display_name} изменил(а) сообщение${replaced ? ' и заменил(а) вложение' : ''}:\n${text}`,
          { replyTo: copy?.message_id || null, map: 'dialog' });
        // Новое вложение менеджер видит копией исправленного сообщения; на неё тоже можно ответить.
        if (replaced) parts.push({ method: 'copyMessage', params: { chat_id: operator.telegram_user_id, from_chat_id: chatId, message_id: messageId }, map: 'message' });
        enqueue(key, bot, 'notice', { parts, dialogId: dialog.id, messageId: replaced ? row.id : null, operatorId: operator.telegram_user_id });
      }
      return { ok: true, action: replaced ? 'client_edit_media' : 'client_edit', messageIds: replaced ? [row.id] : [] };
    }
    if (row.author_type === 'operator') {
      db.prepare('INSERT OR IGNORE INTO client_dialog_versions(message_id,text,kind,edit_date,created_at) VALUES(?,?,?,?,?)').run(row.id, text, 'operator_edit_not_sent', editDate, stamp());
      db.prepare('UPDATE client_dialog_messages SET edited=1 WHERE id=?').run(row.id);
      if (operator) notice(key, bot, operator.telegram_user_id, 'Исправление не отправлено клиенту: Telegram не переносит правки в уже отправленный ответ. Если нужно, ответьте клиенту ещё раз.', { replyTo: messageId });
      return { ok: true, action: 'operator_edit', messageIds: [] };
    }
    return { ok: true, action: 'edit_ignored', messageIds: [] };
  }

  /* ---------- вложения ---------- */
  function saveAttachment(key, attachmentId, bytes) {
    requireBot(key);
    const row = db.prepare('SELECT * FROM client_dialog_attachments WHERE id=? AND bot_key=?').get(Number(attachmentId), key);
    if (!row) fail(404, 'Вложение не найдено');
    if (row.status === 'stored') return { ok: true, status: 'stored' };
    if (row.status !== 'pending') fail(409, 'Вложение уже закрыто');
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail(400, 'Пустой файл');
    if (bytes.length > maxFile) return markAttachment(key, row.id, 'too_large', `Файл больше ${Math.round(maxFile / 1024 / 1024)} МБ`);
    if (storageUsed() + bytes.length > maxStorage) return markAttachment(key, row.id, 'quota_exceeded', QUOTA_ERROR);
    const diskName = crypto.randomUUID();
    fs.writeFileSync(path.join(storage, diskName), bytes, { flag: 'wx' });
    db.prepare("UPDATE client_dialog_attachments SET status='stored',disk_name=?,size=?,error='',stored_at=? WHERE id=?").run(diskName, bytes.length, stamp(), row.id);
    return { ok: true, status: 'stored' };
  }
  function markAttachment(key, attachmentId, status, error) {
    requireBot(key);
    if (!['too_large', 'unavailable', 'quota_exceeded'].includes(status)) fail(400, 'Некорректный статус вложения');
    const row = db.prepare('SELECT * FROM client_dialog_attachments WHERE id=? AND bot_key=?').get(Number(attachmentId), key);
    if (!row) fail(404, 'Вложение не найдено');
    if (row.status !== 'pending') return { ok: true, status: row.status };
    db.prepare('UPDATE client_dialog_attachments SET status=?,error=? WHERE id=?').run(status, oneLine(error, 200) || (status === 'too_large' ? 'Файл слишком большой' : 'Файл недоступен боту'), row.id);
    return { ok: true, status };
  }

  /* ---------- выдача заданий мосту ---------- */
  const view = (row) => ({ id: `${JOB_PREFIX}${row.id}`, kind: row.kind,
    parts: JSON.parse(row.parts).map(({ method, params }) => ({ method, params })), after: JSON.parse(row.after) });
  function orderJobView(job, bot) {
    const summary = job.orderKind === 'order' ? siteOrders.orderSummary(bot.site, job.orderId) : null;
    const text = summary ? `${job.text}\n\nСтатус обработки: ${WORK_LABELS[summary.work.status]}` : job.text;
    const parts = textParts(job.chatId, text);
    if (summary) parts[parts.length - 1].params.reply_markup = keyboard(summary.id);
    return { id: job.id, kind: 'order', parts, after: [] };
  }
  const keyboard = (orderId) => ({ inline_keyboard: [[
    { text: 'В работе', callback_data: `ow:${orderId}:in_work` },
    { text: 'Выполнена', callback_data: `ow:${orderId}:done` },
    { text: 'Отмена', callback_data: `ow:${orderId}:cancelled` }]] });
  function pendingJobs(key) {
    const bot = requireBot(key);
    return tx(() => {
      const expired = db.prepare("SELECT id FROM client_bot_outbox WHERE bot_key=? AND status='sending' AND claimed_at<?").all(key, stamp(now() - LEASE));
      for (const job of expired) settle(key, bot, db.prepare('SELECT * FROM client_bot_outbox WHERE id=?').get(job.id), 'uncertain', 'Отправка прервана; результат доставки неизвестен', []);
      // Задания прежнего менеджера (отключён, заменён, получатель заявок изменён) не выдаются: останавливаются с причиной.
      const current = activeOperator(key)?.telegram_user_id || null;
      let row;
      for (;;) {
        row = db.prepare("SELECT * FROM client_bot_outbox WHERE bot_key=? AND status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1").get(key, stamp());
        if (!row || !row.operator_id || row.operator_id === current) break;
        stopOperatorJobs(key, row.operator_id, 'Менеджер изменён или отключён до отправки');
      }
      if (row) {
        db.prepare("UPDATE client_bot_outbox SET status='sending',claimed_at=?,attempts=attempts+1 WHERE id=?").run(stamp(), row.id);
        return [view(row)];
      }
      // Уведомления о заявках этого сайта — после переписки: ответ клиенту важнее.
      return siteOrders.pendingTelegram('client_bot', bot.site).map((job) => orderJobView(job, bot));
    });
  }

  function settle(key, bot, job, status, error, ids) {
    const finished = ['sent', 'uncertain', 'failed'].includes(status) ? stamp() : null;
    db.prepare(`UPDATE client_bot_outbox SET status=?,error=?,external_ids=?,claimed_at=NULL,next_attempt_at=?,finished_at=COALESCE(?,finished_at) WHERE id=?`)
      .run(status, oneLine(error, 300), JSON.stringify(ids), stamp(now() + 15000 * Math.max(1, job.attempts)), finished, job.id);
    // Номера сообщений у менеджера запоминаются, как только известны: на них можно отвечать.
    const parts = JSON.parse(job.parts);
    ids.forEach((external, index) => {
      const part = parts[index];
      const messageId = Number(external);
      if (!part?.map || !Number.isSafeInteger(messageId) || messageId < 1 || !job.dialog_id) return;
      db.prepare(`INSERT OR IGNORE INTO client_bot_map(bot_key,chat_id,message_id,dialog_id,client_message_id,created_at) VALUES(?,?,?,?,?,?)`)
        .run(key, String(part.params.chat_id), messageId, job.dialog_id, part.map === 'message' ? job.message_id : null, stamp());
    });
    if (job.message_id && status !== 'sending') {
      const delivered = job.kind === 'reply' && status === 'sent' ? Number(ids[0]) || null : null;
      db.prepare('UPDATE client_dialog_messages SET delivery_status=?,delivery_error=?,delivered_message_id=COALESCE(?,delivered_message_id) WHERE id=?')
        .run(DELIVERY.has(status) ? status : 'failed', status === 'sent' ? '' : oneLine(error, 300), delivered, job.message_id);
    }
    // Менеджер сразу узнаёт, что ответ не дошёл или исход неизвестен; повтор — только его новым ответом.
    if (job.kind === 'reply' && ['uncertain', 'failed'].includes(status)) {
      const operator = activeOperator(key);
      if (operator) notice(key, bot, operator.telegram_user_id, status === 'uncertain'
        ? 'Не удалось подтвердить доставку этого ответа клиенту. Автоматически не повторяю, чтобы не было дубля: проверьте переписку и при необходимости ответьте ещё раз.'
        : `Ответ клиенту не доставлен${error ? `: ${oneLine(error, 200)}` : ''}.`, { replyTo: job.reply_to_operator_message });
    }
  }

  function acknowledge(key, body = {}) {
    const bot = requireBot(key);
    const jobId = String(body.jobId || '');
    const ids = Array.isArray(body.externalMessageIds) ? body.externalMessageIds.map(String).filter((id) => /^\d{1,20}$/.test(id)) : [];
    if (siteOrders.isOrderJob(jobId)) {
      const info = siteOrders.orderJob(jobId);
      if (!info || info.transport !== 'client_bot' || info.site !== bot.site) fail(404, 'Отправка не найдена');
      const result = siteOrders.acknowledge(jobId, { ...body, externalMessageIds: ids });
      if (info.kind === 'order' && info.orderId) {
        for (const id of ids) db.prepare('INSERT OR IGNORE INTO client_bot_map(bot_key,chat_id,message_id,order_id,created_at) VALUES(?,?,?,?,?)')
          .run(key, String(info.chatId), Number(id), info.orderId, stamp());
      }
      return result;
    }
    const id = Number(jobId.startsWith(JOB_PREFIX) ? jobId.slice(JOB_PREFIX.length) : NaN);
    if (!Number.isSafeInteger(id) || id < 1) fail(404, 'Отправка не найдена');
    return tx(() => {
      const job = db.prepare('SELECT * FROM client_bot_outbox WHERE id=? AND bot_key=?').get(id, key);
      if (!job) fail(404, 'Отправка не найдена');
      if (job.status === 'sent') return { ok: true, status: 'sent' };
      const known = JSON.parse(job.external_ids || '[]');
      const merged = ids.length >= known.length ? ids : known;
      // Завершённое (uncertain/failed) поздний ответ не оживляет: только подтверждённый успех уточняет исход.
      if (['uncertain', 'failed'].includes(job.status)) {
        if (body.ok === true) { settle(key, bot, job, 'sent', '', merged); return { ok: true, status: 'sent' }; }
        return { ok: false, status: job.status };
      }
      const status = body.ok === true ? 'sent' : body.uncertain ? 'uncertain'
        : body.retryable && job.attempts < ATTEMPTS ? 'pending' : 'failed';
      settle(key, bot, job, status, body.ok === true ? '' : (body.error || 'Не удалось отправить в Telegram'), merged);
      return { ok: body.ok === true, status };
    });
  }

  /* ---------- кнопки статуса заявки ---------- */
  function callback(key, query = {}) {
    const bot = requireBot(key);
    const fromId = idOf(query.from?.id);
    const operator = activeOperator(key);
    const answer = (text, showAlert = false) => ({ ok: true, answer: { text, showAlert }, edit: null });
    if (!operator || operator.telegram_user_id !== fromId) return answer('Кнопка доступна только менеджеру', true);
    const match = /^ow:(\d{1,12}):(in_work|done|cancelled)$/.exec(String(query.data || ''));
    if (!match) return answer('Неизвестная кнопка');
    const orderId = Number(match[1]), status = match[2];
    let result;
    try { result = siteOrders.setWorkStatus(bot.site, orderId, status, 'Менеджер в Telegram'); }
    catch (error) { if (error.status === 404) return answer('Заявка не найдена', true); throw error; }
    if (result.changed) audit(key, 'order_status', 'operator', `заявка №${orderId}: ${WORK_LABELS[status]}`);
    const label = WORK_LABELS[result.work.status];
    const chatId = idOf(query.message?.chat?.id), messageId = positive(query.message?.message_id);
    const original = typeof query.message?.text === 'string' ? query.message.text.replace(/\n\nСтатус обработки: [^\n]*$/u, '') : '';
    const edit = result.changed && chatId === operator.telegram_user_id && messageId && original
      ? { chatId, messageId, text: `${original}\n\nСтатус обработки: ${label}`.slice(0, 4096), replyMarkup: keyboard(orderId) } : null;
    return { ok: true, answer: { text: result.changed ? `Статус: ${label}` : `Уже: ${label}`, showAlert: false }, edit };
  }

  /* ---------- ссылка «Продолжить в Telegram» после заявки ---------- */
  function issueOrderLink({ site, orderId }) {
    const found = botForSite(site);
    if (!found || !found.enabled) return null;
    // Ссылку предлагаем только готовому боту: действующий менеджер привязан и мост недавно подтвердил токен и имя бота.
    if (!activeOperator(found.key) || !bridgeState(found.key).ready) return null;
    const summary = siteOrders.orderSummary(site, orderId);
    if (!summary) return null;
    const token = randomBytes(24).toString('base64url');
    const at = now();
    db.prepare('INSERT INTO client_order_links(bot_key,site,order_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)')
      .run(found.key, site, summary.id, sha256(token), stamp(at), stamp(at + linkTtlMs));
    return { url: `https://t.me/${found.bot.username}?start=o_${token}`, expiresAt: stamp(at + linkTtlMs) };
  }

  /* ---------- владелец: код привязки, статус, отключение ---------- */
  function createOperatorCode(site, actor) {
    const found = botForSite(site);
    if (!found || !found.enabled) fail(409, 'Клиентский бот не подключён: не задано имя бота', 'BOT_DISABLED');
    const recipient = siteOrders.recipientStatus(site);
    if (!recipient.configured || !TELEGRAM_ID.test(recipient.telegramChatId)) fail(409, 'Сначала сохраните получателя заявок: код привязывается к его Telegram ID', 'RECIPIENT_MISSING');
    let code = '';
    const bytes = randomBytes(10);
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    const at = now();
    tx(() => {
      db.prepare('UPDATE client_bot_codes SET expires_at=? WHERE bot_key=? AND used_at IS NULL AND expires_at>?').run(stamp(at), found.key, stamp(at));
      db.prepare('INSERT INTO client_bot_codes(bot_key,code_hash,expected_user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)')
        .run(found.key, sha256(`${found.key}:${code}`), recipient.telegramChatId, oneLine(actor, 80), stamp(at), stamp(at + codeTtlMs));
      audit(found.key, 'operator_code_created', actor, `для Telegram ID получателя …${recipient.telegramChatId.slice(-3)}`);
    });
    return { code, command: `/operator ${code}`, deepLink: `https://t.me/${found.bot.username}?start=op_${code}`, expiresAt: stamp(at + codeTtlMs) };
  }
  function revokeOperator(site, actor) {
    const found = botForSite(site);
    if (!found) fail(404, 'Не найдено');
    const operator = operatorOf(found.key);
    tx(() => {
      if (operator) stopOperatorJobs(found.key, operator.telegram_user_id, 'Менеджер отключён до отправки');
      db.prepare('DELETE FROM client_bot_operators WHERE bot_key=?').run(found.key);
      db.prepare('UPDATE client_bot_codes SET expires_at=? WHERE bot_key=? AND used_at IS NULL').run(stamp(), found.key);
      if (operator) audit(found.key, 'operator_revoked', actor, `отключён ${operator.telegram_user_id}`);
    });
    // Без менеджера уведомления о заявках возвращаются в прежний канал.
    if (siteOrders.recipientStatus(site).transport === 'client_bot') siteOrders.setTransport(site, { transport: 'project_bot' });
    return status(site);
  }
  function transportReady(site, chatId) {
    const found = botForSite(site);
    if (!found || !found.enabled) return { ok: false, reason: 'Клиентский бот не подключён' };
    const operator = operatorOf(found.key);
    if (!operator) return { ok: false, reason: 'Менеджер ещё не привязан к боту' };
    if (operator.telegram_user_id !== String(chatId)) return { ok: false, reason: 'Привязанный менеджер не совпадает с получателем заявок' };
    const bridge = bridgeState(found.key);
    if (!bridge.ready) return { ok: false, reason: `Сервис chat не подтвердил бота: ${bridge.error}` };
    return { ok: true };
  }
  function status(site) {
    const found = botForSite(site);
    if (!found) fail(404, 'Не найдено');
    const operator = operatorOf(found.key);
    const code = db.prepare('SELECT expires_at,expected_user_id FROM client_bot_codes WHERE bot_key=? AND used_at IS NULL AND expires_at>? ORDER BY id DESC LIMIT 1').get(found.key, stamp());
    const recipient = siteOrders.recipientStatus(site);
    const counts = db.prepare('SELECT count(*) AS dialogs, COALESCE(sum(unread),0) AS unread FROM client_dialogs WHERE bot_key=?').get(found.key);
    const problems = db.prepare(`SELECT count(*) AS n FROM client_dialog_messages WHERE bot_key=? AND delivery_status IN ('uncertain','failed')`).get(found.key).n;
    return {
      enabled: found.enabled, username: found.enabled ? found.bot.username : '',
      operator: operator ? { bound: true, telegramUserId: operator.telegram_user_id, boundAt: operator.bound_at,
        matchesRecipient: operator.telegram_user_id === recipient.telegramChatId } : { bound: false },
      pendingCode: code ? { expiresAt: code.expires_at } : null,
      transport: recipient.transport, transportReady: transportReady(site, recipient.telegramChatId),
      dialogs: counts.dialogs, unread: counts.unread, deliveryProblems: problems,
      bridge: bridgeState(found.key), storage: { usedBytes: storageUsed(), limitBytes: maxStorage },
      events: db.prepare('SELECT kind,actor,detail,created_at FROM client_bot_audit WHERE bot_key=? ORDER BY id DESC LIMIT 20').all(found.key)
        .map((row) => ({ kind: row.kind, actor: row.actor, detail: row.detail, createdAt: row.created_at })),
    };
  }

  /* ---------- владелец: диалоги ---------- */
  const dialogJSON = (row) => ({ id: row.id, name: row.display_name, username: row.username, telegramUserId: row.telegram_user_id,
    source: row.source, orderId: row.order_id, unread: row.unread, createdAt: row.created_at, lastMessageAt: row.last_message_at,
    lastMessage: oneLine(db.prepare("SELECT text FROM client_dialog_messages WHERE dialog_id=? AND direction<>'system' ORDER BY id DESC LIMIT 1").get(row.id)?.text, 160) });
  function listDialogs(site, { limit, beforeId } = {}) {
    const found = botForSite(site);
    if (!found) fail(404, 'Не найдено');
    const size = limit === undefined || limit === null || limit === '' ? 50 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > LIST_LIMIT) fail(400, `Параметр limit — целое от 1 до ${LIST_LIMIT}`);
    const cursor = beforeId === undefined || beforeId === null || beforeId === '' ? null : Number(beforeId);
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) fail(400, 'Некорректный курсор beforeId');
    const rows = cursor === null
      ? db.prepare('SELECT * FROM client_dialogs WHERE bot_key=? AND company_code=? ORDER BY id DESC LIMIT ?').all(found.key, found.bot.companyCode, size + 1)
      : db.prepare('SELECT * FROM client_dialogs WHERE bot_key=? AND company_code=? AND id<? ORDER BY id DESC LIMIT ?').all(found.key, found.bot.companyCode, cursor, size + 1);
    const page = rows.slice(0, size);
    return { dialogs: page.map(dialogJSON), nextCursor: rows.length > size ? page[page.length - 1].id : null };
  }
  function dialogView(site, dialogId) {
    const found = botForSite(site);
    const id = Number(dialogId);
    if (!found || !Number.isSafeInteger(id) || id < 1) fail(404, 'Диалог не найден');
    const dialog = db.prepare('SELECT * FROM client_dialogs WHERE id=? AND bot_key=? AND company_code=?').get(id, found.key, found.bot.companyCode);
    if (!dialog) fail(404, 'Диалог не найден');
    const messages = db.prepare('SELECT * FROM client_dialog_messages WHERE dialog_id=? ORDER BY id').all(id).map((row) => ({
      id: row.id, direction: row.direction, authorType: row.author_type, text: row.text, createdAt: row.created_at,
      deliveryStatus: row.delivery_status, deliveryError: row.delivery_error, edited: Boolean(row.edited),
      versions: db.prepare('SELECT text,kind,created_at FROM client_dialog_versions WHERE message_id=? ORDER BY id').all(row.id)
        .map((version) => ({ text: version.text, kind: version.kind, createdAt: version.created_at })),
      attachments: db.prepare('SELECT id,kind,mime,name,size,status,error,superseded_at FROM client_dialog_attachments WHERE message_id=? ORDER BY id').all(row.id)
        .map((file) => ({ id: file.id, kind: file.kind, mime: file.mime, name: file.name, size: file.size, status: file.status, error: file.error,
          superseded: Boolean(file.superseded_at), supersededAt: file.superseded_at || null })),
    }));
    const order = dialog.order_id ? siteOrders.orderSummary(site, dialog.order_id) : null;
    return { dialog: dialogJSON(dialog), order: order ? { id: order.id, work: order.work } : null, messages };
  }
  function markRead(site, dialogId) {
    const { dialog } = dialogView(site, dialogId);
    db.prepare('UPDATE client_dialogs SET unread=0 WHERE id=?').run(dialog.id);
    return { ok: true };
  }
  function attachmentFile(site, attachmentId) {
    const found = botForSite(site);
    const id = Number(attachmentId);
    if (!found || !Number.isSafeInteger(id) || id < 1) fail(404, 'Файл не найден');
    const row = db.prepare('SELECT * FROM client_dialog_attachments WHERE id=? AND bot_key=? AND company_code=?').get(id, found.key, found.bot.companyCode);
    if (!row) fail(404, 'Файл не найден');
    if (row.status !== 'stored' || !/^[0-9a-f-]{36}$/.test(row.disk_name || '')) fail(404, 'Файл не сохранён: ' + (row.error || 'нет копии'));
    return { file: path.join(storage, row.disk_name), mime: row.mime, name: row.name, size: row.size, inline: INLINE_MIME.has(row.mime) };
  }

  /* ---------- HTTP ---------- */
  /* Внутренние маршруты моста: /content/internal/client-bot/<route>?botKey=… Ключ службы проверяет server.js. */
  async function handleInternal(request, response, url, { readJson, readRaw, send }) {
    const route = url.pathname.slice('/content/internal/client-bot'.length);
    const key = String(url.searchParams.get('botKey') || '');
    if (route === '/receive' && request.method === 'POST') return send(response, 200, receive(key, (await readJson(request)).update));
    if (route === '/callback' && request.method === 'POST') return send(response, 200, callback(key, (await readJson(request)).callback));
    if (route === '/outbox' && request.method === 'GET') return send(response, 200, { jobs: pendingJobs(key) });
    if (route === '/heartbeat' && request.method === 'POST') return send(response, 200, heartbeat(key, await readJson(request)));
    if (route === '/acknowledge' && request.method === 'POST') return send(response, 200, acknowledge(key, await readJson(request)));
    if (route === '/attachment' && request.method === 'POST') {
      requireBot(key);
      return send(response, 200, saveAttachment(key, url.searchParams.get('id'), await readRaw(request, maxFile)));
    }
    if (route === '/attachment-status' && request.method === 'POST') {
      const body = await readJson(request);
      return send(response, 200, markAttachment(key, body.attachmentId, body.status, body.error));
    }
    fail(404, 'Маршрут не найден');
  }
  /* Кабинет владельца: /content/<site>/client-bot… и /content/<site>/client-dialogs… Сессию и роль проверяет server.js. */
  async function handleCabinet(request, response, url, parts, { session, requireCsrf, send }) {
    const site = parts[1];
    if (!botForSite(site)) fail(404, 'Не найдено');
    const actor = session.user.login || `user:${session.user.id}`;
    if (request.method !== 'GET') requireCsrf(request, session);
    const headers = { 'cache-control': 'no-store' };
    if (parts[2] === 'client-bot') {
      if (parts.length === 3 && request.method === 'GET') return send(response, 200, status(site), headers);
      if (parts.length === 4 && parts[3] === 'operator-code' && request.method === 'POST') return send(response, 201, createOperatorCode(site, actor), headers);
      if (parts.length === 4 && parts[3] === 'revoke-operator' && request.method === 'POST') return send(response, 200, revokeOperator(site, actor), headers);
      fail(404, 'Не найдено');
    }
    if (parts.length === 3 && request.method === 'GET') {
      return send(response, 200, listDialogs(site, { limit: url.searchParams.get('limit'), beforeId: url.searchParams.get('beforeId') }), headers);
    }
    if (parts.length === 5 && parts[3] === 'attachments' && request.method === 'GET') {
      const file = attachmentFile(site, parts[4]);
      const stat = fs.statSync(file.file);
      const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      response.writeHead(200, {
        'content-type': file.inline ? file.mime : 'application/octet-stream',
        'content-length': stat.size,
        'content-disposition': `${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        'cache-control': 'private, no-store',
      });
      fs.createReadStream(file.file).pipe(response);
      return undefined;
    }
    if (parts.length === 4 && request.method === 'GET') return send(response, 200, dialogView(site, parts[3]), headers);
    if (parts.length === 5 && parts[4] === 'read' && request.method === 'POST') return send(response, 200, markRead(site, parts[3]), headers);
    fail(404, 'Не найдено');
  }

  return { receive, callback, pendingJobs, acknowledge, heartbeat, bridgeState, saveAttachment, markAttachment, issueOrderLink, createOperatorCode,
    revokeOperator, transportReady, status, listDialogs, dialogView, markRead, attachmentFile, handleInternal, handleCabinet,
    enabledFor: (site) => Boolean(botForSite(site)?.enabled), storage };
}

module.exports = { createClientDialogs, JOB_PREFIX, WORK_LABELS };
