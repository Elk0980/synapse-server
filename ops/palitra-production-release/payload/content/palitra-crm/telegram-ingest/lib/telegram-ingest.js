'use strict';

/**
 * Palitra: приём Telegram-обращений внутри СУЩЕСТВУЮЩЕГО обработчика Telegram.
 * Модуль не открывает сокетов, не делает polling/getUpdates, не отправляет сообщений и не читает секреты.
 * Источник истины о допуске — только явная конфигурация хоста (fail-closed).
 * Данные из браузера сюда не попадают: ingress требует capability-символ, который нельзя передать через JSON.
 */

const COMPANY = 'palitra-love';
const MAX_TEXT = 4096;
const MAX_DELETE_IDS = 1000;
const OPEN = ['new', 'review', 'accepted'];
const DECISIONS = {
  new: ['accepted', 'rejected', 'closed'],
  review: ['accepted', 'rejected', 'closed'],
  accepted: ['closed'],
  rejected: [],
  closed: []
};
// Порядок важен: явный заказ сильнее вопроса цены/срока. Кириллица: без \b.
const INTENTS = [
  ['order', /заказ|оформ|заброни|купить|хочу\s+(?:шар|букет|набор|композиц)|можно\s+(?:ли\s+)?(?:сделать|получить|заказ)/i],
  ['price', /цен[аеуыо]|стоим|сколько\s+стоит|почём|почем|прайс|\d+\s*(?:₽|руб)/i],
  ['deadline', /срок|когда\s+(?:будет|сможете|можно|привез)|успеете|сегодня|завтра|доставк|самовывоз|к\s+\d{1,2}[:.]\d{2}/i]
];
const ID = /^-?\d{1,20}$/;
const CONNECTION_ID = /^[A-Za-z0-9_\-:.=+/]{1,128}$/;
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeInt = (value) => Number.isSafeInteger(value) ? value : null;
// Telegram ID ≤ 52 бит; храним строкой, чтобы не терять точность и не сравнивать число со строкой.
const tgId = (value) => Number.isSafeInteger(value) ? String(value) : null;
const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

function configId(value, label) {
  const result = Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== 'string' || !ID.test(result)) throw new TypeError(`Некорректный идентификатор: ${label}`);
  return result;
}
function configName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) throw new TypeError(`Нужно имя: ${label}`);
  return value.trim();
}

/** Проверяет и замораживает конфигурацию. Пустая конфигурация допустима и не принимает ничего. */
function normalizeConfig(config) {
  if (!plain(config)) throw new TypeError('Требуется конфигурация приёма Telegram');
  const botId = configId(config.botId, 'botId');
  if (botId.startsWith('-') || botId === '0') throw new TypeError('botId должен быть ID бота');
  if (config.botPrivateChats !== undefined && typeof config.botPrivateChats !== 'boolean') {
    throw new TypeError('botPrivateChats должен быть true/false');
  }
  const managers = new Map();
  for (const item of config.managers || []) {
    const userId = configId(item?.userId, 'managers.userId');
    if (userId === botId || managers.has(userId)) throw new TypeError('Повтор или конфликт в managers');
    managers.set(userId, Object.freeze({ userId, name: configName(item.name, 'managers.name') }));
  }
  const groups = new Map();
  for (const item of config.commentGroups || []) {
    const chatId = configId(item?.chatId, 'commentGroups.chatId');
    const linkedChannelId = configId(item.linkedChannelId, 'commentGroups.linkedChannelId');
    if (!chatId.startsWith('-') || !linkedChannelId.startsWith('-') || groups.has(chatId)) {
      throw new TypeError('commentGroups: нужны ID группы и канала (отрицательные), без повторов');
    }
    if (item.channelUsername !== undefined && !USERNAME.test(item.channelUsername)) {
      throw new TypeError('commentGroups.channelUsername некорректен');
    }
    groups.set(chatId, Object.freeze({ chatId, linkedChannelId, channelUsername: item.channelUsername || null }));
  }
  const connections = new Map();
  for (const item of config.businessConnections || []) {
    if (typeof item?.id !== 'string' || !CONNECTION_ID.test(item.id) || connections.has(item.id)) {
      throw new TypeError('businessConnections.id некорректен или повторяется');
    }
    const ownerUserId = configId(item.ownerUserId, 'businessConnections.ownerUserId');
    if (ownerUserId.startsWith('-')) throw new TypeError('ownerUserId должен быть ID пользователя');
    connections.set(item.id, Object.freeze({ id: item.id, ownerUserId, name: configName(item.name, 'businessConnections.name') }));
  }
  // Способ получения update фиксируется конфигурацией хоста: webhook (проверенный secret token) или
  // существующий доверенный getUpdates-диспетчер хоста. Второй способ не подменяет флаг webhook.
  if (config.ingress !== undefined && !['webhook', 'polling'].includes(config.ingress)) {
    throw new TypeError('ingress: webhook или polling');
  }
  return Object.freeze({ botId, botPrivateChats: config.botPrivateChats === true, managers, groups, connections,
    ingress: config.ingress === 'polling' ? 'polling' : 'webhook' });
}

function classify(content) {
  if (content.kind !== 'text' && !content.text) return 'ambiguous';
  for (const [intent, pattern] of INTENTS) if (pattern.test(content.text)) return intent;
  return 'ambiguous';
}

// Только однозначная благодарность/реакция без вопроса и вложения. Приветствие остаётся в разборе.
function isAcknowledgement(content) {
  if (content.kind !== 'text' || classify(content) !== 'ambiguous') return false;
  const text = content.text.trim();
  return /^(?:спасибо(?:\s+(?:большое|вам|огромное))?|благодарю|красиво|очень\s+красиво|красота|класс|супер|восторг|👍|❤|❤️|🤍|😍)[\s!.❤❤️🤍😍👍]*$/iu.test(text);
}

/** Извлекает только нужное: текст/подпись и ссылку на файл. Контакты/геоданные не сохраняются. */
function extract(message) {
  const text = clip(message.text ?? message.caption, MAX_TEXT);
  const file = (value) => plain(value) && typeof value.file_id === 'string' && value.file_id.length <= 256
    ? { fileId: value.file_id, fileUniqueId: typeof value.file_unique_id === 'string' ? value.file_unique_id.slice(0, 128) : null }
    : { fileId: null, fileUniqueId: null };
  if (Array.isArray(message.photo) && message.photo.length) {
    return { kind: 'photo', text, ...file(message.photo[message.photo.length - 1]) };
  }
  for (const kind of ['voice', 'video_note', 'video', 'audio', 'document', 'animation', 'sticker']) {
    if (message[kind] !== undefined) return { kind, text, ...file(message[kind]) };
  }
  if (message.contact !== undefined) return { kind: 'contact', text: '', fileId: null, fileUniqueId: null };
  if (message.location !== undefined || message.venue !== undefined) return { kind: 'location', text: '', fileId: null, fileUniqueId: null };
  if (typeof message.text === 'string') return { kind: 'text', text, fileId: null, fileUniqueId: null };
  return { kind: 'other', text, fileId: null, fileUniqueId: null };
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db общая SQLite хоста
 * @param {object} options.config явная доверенная конфигурация (см. README)
 * @param {Function} [options.transact] та же transact-функция, что у существующего siteOrders
 * @param {Function} [options.authorizeOrderLink] проверка workspace: ({inquiryId,orderId,actor}) => true
 */
function createTelegramIngest({ db, config, now = Date.now, transact = null, authorizeOrderLink = null } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Требуется SQLite database');
  if (typeof now !== 'function') throw new TypeError('Требуется функция времени');
  if (transact !== null && typeof transact !== 'function') throw new TypeError('Некорректная transact-функция');
  if (authorizeOrderLink !== null && typeof authorizeOrderLink !== 'function') throw new TypeError('Некорректная проверка заказа');
  const cfg = normalizeConfig(config);
  const botNs = `bot:${cfg.botId}`;
  const capability = Symbol('palitra.telegram-ingest.host');

  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS tg_ingest_updates (
      bot_id TEXT NOT NULL, update_id INTEGER NOT NULL, outcome TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY(bot_id,update_id)
    );
    CREATE TABLE IF NOT EXISTS tg_ingest_connections (
      connection_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), can_reply INTEGER NOT NULL CHECK(can_reply IN (0,1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tg_ingest_customers (
      id INTEGER PRIMARY KEY, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      tg_user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      UNIQUE(company_code,tg_user_id)
    );
    CREATE TABLE IF NOT EXISTS tg_ingest_posts (
      chat_id TEXT NOT NULL, group_message_id INTEGER NOT NULL, channel_id TEXT NOT NULL, post_id INTEGER NOT NULL,
      PRIMARY KEY(chat_id,group_message_id)
    );
    CREATE TABLE IF NOT EXISTS tg_ingest_conversations (
      id INTEGER PRIMARY KEY, account_ns TEXT NOT NULL, chat_id TEXT NOT NULL, thread_key TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('bot_private','business','comments')), connection_id TEXT,
      customer_id INTEGER REFERENCES tg_ingest_customers(id), sender_chat_id TEXT,
      post_id INTEGER, post_link TEXT, created_at TEXT NOT NULL,
      UNIQUE(account_ns,chat_id,thread_key)
    );
    CREATE TABLE IF NOT EXISTS tg_ingest_inquiries (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES tg_ingest_conversations(id),
      customer_id INTEGER REFERENCES tg_ingest_customers(id),
      status TEXT NOT NULL CHECK(status IN ('new','review','accepted','rejected','closed')),
      intent TEXT NOT NULL CHECK(intent IN ('order','price','deadline','ambiguous')),
      historical INTEGER NOT NULL CHECK(historical IN (0,1)),
      notify_state TEXT NOT NULL CHECK(notify_state IN ('pending','notified','historical')),
      edited_after_decision INTEGER NOT NULL DEFAULT 0 CHECK(edited_after_decision IN (0,1)),
      order_id INTEGER, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tg_ingest_one_open_inquiry
      ON tg_ingest_inquiries(conversation_id) WHERE status IN ('new','review','accepted');
    CREATE INDEX IF NOT EXISTS tg_ingest_notify ON tg_ingest_inquiries(notify_state,id);
    CREATE TABLE IF NOT EXISTS tg_ingest_messages (
      id INTEGER PRIMARY KEY, account_ns TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      conversation_id INTEGER REFERENCES tg_ingest_conversations(id),
      inquiry_id INTEGER REFERENCES tg_ingest_inquiries(id), connection_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      author_kind TEXT NOT NULL CHECK(author_kind IN ('customer','anonymous','manager','staff_anonymous','channel','bot')),
      author_label TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
      file_id TEXT, file_unique_id TEXT, reply_to_message_id INTEGER, link TEXT,
      sent_at TEXT NOT NULL, edited_at TEXT, deleted_at TEXT,
      historical INTEGER NOT NULL CHECK(historical IN (0,1)), received_at TEXT NOT NULL,
      UNIQUE(account_ns,chat_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS tg_ingest_revisions (
      id INTEGER PRIMARY KEY, message_row_id INTEGER NOT NULL REFERENCES tg_ingest_messages(id),
      kind TEXT NOT NULL, text TEXT NOT NULL, file_id TEXT, replaced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tg_ingest_audit (
      id INTEGER PRIMARY KEY, inquiry_id INTEGER NOT NULL REFERENCES tg_ingest_inquiries(id),
      action TEXT NOT NULL, actor_id TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
  `);

  const stamp = (ms = now()) => new Date(ms).toISOString();
  const unixStamp = (seconds) => Number.isSafeInteger(seconds) && seconds > 0 ? stamp(seconds * 1000) : stamp();
  let savepoint = 0;
  const atomic = transact || ((fn) => {
    const name = `tg_ingest_${++savepoint}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
  });

  const q = {
    seenUpdate: db.prepare('SELECT outcome FROM tg_ingest_updates WHERE bot_id=? AND update_id=?'),
    addUpdate: db.prepare('INSERT INTO tg_ingest_updates(bot_id,update_id,outcome,received_at) VALUES(?,?,?,?)'),
    connection: db.prepare('SELECT * FROM tg_ingest_connections WHERE connection_id=?'),
    saveConnection: db.prepare(`INSERT INTO tg_ingest_connections(connection_id,owner_user_id,enabled,can_reply,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET
      owner_user_id=excluded.owner_user_id,enabled=excluded.enabled,can_reply=excluded.can_reply,updated_at=excluded.updated_at`),
    customer: db.prepare('SELECT * FROM tg_ingest_customers WHERE company_code=? AND tg_user_id=?'),
    addCustomer: db.prepare(`INSERT INTO tg_ingest_customers(company_code,tg_user_id,display_name,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?)`),
    touchCustomer: db.prepare('UPDATE tg_ingest_customers SET display_name=?,last_seen_at=? WHERE id=?'),
    post: db.prepare('SELECT * FROM tg_ingest_posts WHERE chat_id=? AND group_message_id=?'),
    savePost: db.prepare('INSERT OR IGNORE INTO tg_ingest_posts(chat_id,group_message_id,channel_id,post_id) VALUES(?,?,?,?)'),
    conversation: db.prepare('SELECT * FROM tg_ingest_conversations WHERE account_ns=? AND chat_id=? AND thread_key=?'),
    conversationById: db.prepare('SELECT * FROM tg_ingest_conversations WHERE id=?'),
    addConversation: db.prepare(`INSERT INTO tg_ingest_conversations
      (account_ns,chat_id,thread_key,source,connection_id,customer_id,sender_chat_id,post_id,post_link,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`),
    bindCustomer: db.prepare('UPDATE tg_ingest_conversations SET customer_id=? WHERE id=? AND customer_id IS NULL'),
    message: db.prepare('SELECT * FROM tg_ingest_messages WHERE account_ns=? AND chat_id=? AND message_id=?'),
    addMessage: db.prepare(`INSERT INTO tg_ingest_messages
      (account_ns,chat_id,message_id,conversation_id,inquiry_id,connection_id,direction,author_kind,author_label,kind,text,
       file_id,file_unique_id,reply_to_message_id,link,sent_at,edited_at,historical,received_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    editMessage: db.prepare('UPDATE tg_ingest_messages SET kind=?,text=?,file_id=?,file_unique_id=?,edited_at=? WHERE id=?'),
    addRevision: db.prepare('INSERT INTO tg_ingest_revisions(message_row_id,kind,text,file_id,replaced_at) VALUES(?,?,?,?,?)'),
    markDeleted: db.prepare(`UPDATE tg_ingest_messages SET deleted_at=?
      WHERE account_ns=? AND chat_id=? AND message_id=? AND deleted_at IS NULL`),
    openInquiry: db.prepare(`SELECT * FROM tg_ingest_inquiries WHERE conversation_id=? AND status IN ('new','review','accepted')`),
    inquiry: db.prepare('SELECT * FROM tg_ingest_inquiries WHERE id=?'),
    addInquiry: db.prepare(`INSERT INTO tg_ingest_inquiries
      (conversation_id,customer_id,status,intent,historical,notify_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`),
    promote: db.prepare(`UPDATE tg_ingest_inquiries SET status='new',intent=?,updated_at=? WHERE id=? AND status='review'`),
    liveActivity: db.prepare(`UPDATE tg_ingest_inquiries SET historical=0,notify_state='pending',updated_at=?
      WHERE id=? AND notify_state='historical'`),
    flagEdited: db.prepare(`UPDATE tg_ingest_inquiries SET edited_after_decision=1,updated_at=?
      WHERE id=? AND status IN ('accepted','rejected','closed')`),
    audit: db.prepare('INSERT INTO tg_ingest_audit(inquiry_id,action,actor_id,detail,created_at) VALUES(?,?,?,?,?)')
  };

  const result = (status, reason, extra = {}) => ({ status, reason, ...extra });

  /** Допуск business connection: только из конфигурации и не отозванное событием Telegram. */
  function businessAccount(connectionId) {
    const known = typeof connectionId === 'string' ? cfg.connections.get(connectionId) : null;
    if (!known) return { error: 'unknown_business_connection' };
    const state = q.connection.get(known.id);
    if (state && (state.enabled !== 1 || state.owner_user_id !== known.ownerUserId)) return { error: 'business_connection_disabled' };
    return { account: known };
  }

  function customerFor(user, historical) {
    const userId = tgId(user.id);
    const name = clip([user.first_name, user.last_name].filter((part) => typeof part === 'string').join(' ').trim(), 128);
    const at = stamp();
    const existing = q.customer.get(COMPANY, userId);
    if (existing) {
      if (!historical) q.touchCustomer.run(name || existing.display_name, at, existing.id);
      return existing.id;
    }
    return Number(q.addCustomer.run(COMPANY, userId, name, at, at).lastInsertRowid);
  }

  function conversationFor(key, create) {
    const found = q.conversation.get(key.ns, key.chatId, key.threadKey);
    if (found) return found;
    if (!create) return null;
    const id = Number(q.addConversation.run(key.ns, key.chatId, key.threadKey, key.source, key.connectionId ?? null,
      key.customerId ?? null, key.senderChatId ?? null, key.postId ?? null, key.postLink ?? null, stamp()).lastInsertRowid);
    return q.conversationById.get(id);
  }

  /** Входящее сообщение клиента: одно открытое обращение на беседу; закрытое никогда не продолжается. */
  function attachInquiry(conversation, customerId, content, historical, forceReview) {
    const intent = forceReview ? 'ambiguous' : classify(content);
    const open = q.openInquiry.get(conversation.id);
    if (open) {
      if (intent !== 'ambiguous') q.promote.run(intent, stamp(), open.id);
      if (!historical) q.liveActivity.run(stamp(), open.id);
      const notify = !historical && open.notify_state === 'historical';
      return { inquiryId: open.id, created: false, notify };
    }
    const at = stamp();
    const id = Number(q.addInquiry.run(conversation.id, customerId ?? null, intent === 'ambiguous' ? 'review' : 'new', intent,
      historical ? 1 : 0, historical ? 'historical' : 'pending', at, at).lastInsertRowid);
    return { inquiryId: id, created: true, notify: !historical };
  }

  function applyEdit(row, content, editDate, historical) {
    const editedAt = unixStamp(editDate);
    if (row.edited_at && editedAt <= row.edited_at) return result('ignored', 'stale_edit', { messageRowId: row.id });
    const changed = row.kind !== content.kind || row.text !== content.text || row.file_id !== content.fileId;
    if (changed) q.addRevision.run(row.id, row.kind, row.text, row.file_id, editedAt);
    q.editMessage.run(content.kind, content.text, content.fileId, content.fileUniqueId, editedAt, row.id);
    if (row.inquiry_id) {
      const inquiry = q.inquiry.get(row.inquiry_id);
      const intent = row.author_kind === 'customer' ? classify(content) : 'ambiguous';
      if (inquiry.status === 'review' && intent !== 'ambiguous') q.promote.run(intent, stamp(), inquiry.id);
      // Решение сотрудника не меняется правкой клиента; только флаг для внимания.
      if (changed) q.flagEdited.run(stamp(), inquiry.id);
      if (!historical) q.liveActivity.run(stamp(), inquiry.id);
    }
    return result('stored', 'edited', { messageRowId: row.id, inquiryId: row.inquiry_id ?? null });
  }

  /** Определяет канал, автора и беседу. Ничего не пишет; возвращает {error} или план записи. */
  function plan(message, business) {
    if (!plain(message) || !plain(message.chat)) return { error: 'malformed' };
    const chatId = tgId(message.chat.id);
    const messageId = safeInt(message.message_id);
    if (!chatId || !messageId || messageId < 1) return { error: 'malformed' };
    const from = plain(message.from) ? message.from : null;
    const fromId = from ? tgId(from.id) : null;
    if (from && !fromId) return { error: 'malformed' };
    const replyTo = plain(message.reply_to_message) ? safeInt(message.reply_to_message.message_id) : null;

    if (business) {
      const { account, error } = businessAccount(message.business_connection_id);
      if (error) return { error };
      if (message.chat.type !== 'private') return { error: 'business_chat_not_private' };
      const base = { ns: `biz:${account.ownerUserId}`, chatId, messageId, replyTo, source: 'business',
        connectionId: account.id, threadKey: 'dm' };
      if (plain(message.sender_business_bot)) {
        if (tgId(message.sender_business_bot.id) !== cfg.botId) return { error: 'foreign_business_bot' };
        return { ...base, direction: 'out', authorKind: 'bot', authorLabel: 'Бот Palitra' };
      }
      if (fromId === account.ownerUserId) return { ...base, direction: 'out', authorKind: 'manager', authorLabel: account.name };
      // Входящее в личном чате бизнес-аккаунта возможно только от собеседника этого чата.
      if (!from || from.is_bot === true || fromId !== chatId) return { error: 'forged_business_sender' };
      return { ...base, direction: 'in', authorKind: 'customer', authorLabel: '', customer: from };
    }

    if (message.chat.type === 'private') {
      if (!cfg.botPrivateChats) return { error: 'bot_private_disabled' };
      if (!from || fromId !== chatId || from.is_bot === true) return { error: 'forged_private_sender' };
      if (cfg.managers.has(fromId)) return { ignore: 'staff_private_chat' };
      return { ns: botNs, chatId, messageId, replyTo, source: 'bot_private', threadKey: 'dm',
        direction: 'in', authorKind: 'customer', authorLabel: '', customer: from };
    }

    const group = ['group', 'supergroup'].includes(message.chat.type) ? cfg.groups.get(chatId) : null;
    if (!group) return { error: 'unknown_chat' };
    if (message.is_automatic_forward === true) {
      const origin = plain(message.forward_origin) ? message.forward_origin : null;
      const channelId = origin?.type === 'channel' && plain(origin.chat) ? tgId(origin.chat.id) : null;
      const postId = safeInt(origin?.message_id);
      if (channelId !== group.linkedChannelId || !postId) return { ignore: 'foreign_automatic_forward' };
      return { post: { chatId, groupMessageId: messageId, channelId, postId } };
    }
    const target = replyTo ? q.message.get(botNs, chatId, replyTo) : null;
    const targetConversation = target?.conversation_id ? q.conversationById.get(target.conversation_id) : null;
    const targetRoot = targetConversation?.thread_key?.match(/^post:(\d+):/);
    const root = safeInt(message.message_thread_id) ?? (targetRoot ? Number(targetRoot[1]) : replyTo);
    const post = root ? q.post.get(chatId, root) : null;
    const postLink = post && group.channelUsername ? `https://t.me/${group.channelUsername}/${post.post_id}` : null;
    const base = { ns: botNs, chatId, messageId, replyTo, source: 'comments', postId: post?.post_id ?? null, postLink,
      link: postLink ? `${postLink}?comment=${messageId}` : null };
    const senderChat = plain(message.sender_chat) ? tgId(message.sender_chat.id) : null;
    if (plain(message.sender_chat) && !senderChat) return { error: 'malformed' };
    if (senderChat === chatId) return { ...base, direction: 'out', authorKind: 'staff_anonymous', authorLabel: 'Администратор группы' };
    if (senderChat === group.linkedChannelId) return { ...base, direction: 'out', authorKind: 'channel', authorLabel: 'Канал Palitra' };
    if (senderChat) {
      return { ...base, direction: 'in', authorKind: 'anonymous', authorLabel: 'Анонимный отправитель',
        threadKey: `post:${root || 0}:chat:${senderChat}`, senderChatId: senderChat };
    }
    if (!from) return { error: 'malformed' };
    if (from.is_bot === true) {
      return fromId === cfg.botId ? { ...base, direction: 'out', authorKind: 'bot', authorLabel: 'Бот Palitra' }
        : { ignore: 'foreign_bot' };
    }
    const manager = cfg.managers.get(fromId);
    if (manager) return { ...base, direction: 'out', authorKind: 'manager', authorLabel: manager.name };
    return { ...base, direction: 'in', authorKind: 'customer', authorLabel: '', customer: from,
      threadKey: `post:${root || 0}:user:${fromId}` };
  }

  function handleMessage(message, { business, edited, historical }) {
    const p = plan(message, business);
    if (p.error) return result('rejected', p.error);
    if (p.ignore) return result('ignored', p.ignore);
    if (p.post) {
      q.savePost.run(p.post.chatId, p.post.groupMessageId, p.post.channelId, p.post.postId);
      return result('ignored', 'channel_post_forward');
    }
    const content = extract(message);
    const existing = q.message.get(p.ns, p.chatId, p.messageId);
    if (existing) {
      if (!edited) return result('duplicate', 'message_already_stored', { messageRowId: existing.id });
      const outcome = applyEdit(existing, content, safeInt(message.edit_date), historical);
      // Благодарность может быть отредактирована в вопрос заказа: такой лид нельзя потерять.
      if (outcome.status === 'stored' && existing.inquiry_id === null && p.direction === 'in'
        && p.customer && classify(content) !== 'ambiguous') {
        const customerId = customerFor(p.customer, historical);
        const conversation = conversationFor({ ...p, customerId }, true);
        if (conversation.customer_id === null) q.bindCustomer.run(customerId, conversation.id);
        const link = attachInquiry(conversation, customerId, content, historical, false);
        db.prepare('UPDATE tg_ingest_messages SET conversation_id=?,inquiry_id=? WHERE id=?')
          .run(conversation.id, link.inquiryId, existing.id);
        return { ...outcome, conversationId: conversation.id, inquiryId: link.inquiryId,
          notifyInquiryId: link.notify ? link.inquiryId : null };
      }
      return outcome;
    }

    // Служебные сообщения Telegram (вступление/переименование и т.п.) не являются обращениями.
    if (content.kind === 'other' && !content.text && !content.fileId) return result('ignored', 'service_message');

    let conversation;
    let customerId = null;
    let replyInquiryId = null;
    const acknowledgement = p.direction === 'in' && isAcknowledgement(content);
    if (p.direction === 'in') {
      const existingCustomer = p.customer ? q.customer.get(COMPANY, tgId(p.customer.id)) : null;
      customerId = acknowledgement ? (existingCustomer?.id ?? null) : (p.customer ? customerFor(p.customer, historical) : null);
      // Реакцию нового человека сохраняем, но не заводим клиента и заявку.
      conversation = conversationFor({ ...p, customerId }, !acknowledgement);
      if (customerId && conversation.customer_id === null) q.bindCustomer.run(customerId, conversation.id);
    } else if (p.source === 'comments') {
      // Ответ сотрудника в группе относится к беседе того сообщения, на которое он отвечает; клиента не создаёт.
      const target = p.replyTo ? q.message.get(p.ns, p.chatId, p.replyTo) : null;
      conversation = target?.conversation_id ? q.conversationById.get(target.conversation_id) : null;
      replyInquiryId = target?.inquiry_id ?? null;
    } else {
      conversation = conversationFor(p, true);
    }

    const activeInquiry = conversation ? q.openInquiry.get(conversation.id) : null;
    const link = p.direction === 'in' && conversation
      ? (acknowledgement
        ? (activeInquiry ? { inquiryId: activeInquiry.id, created: false, notify: false } : null)
        : attachInquiry(conversation, customerId, content, historical, p.authorKind === 'anonymous'))
      : ((replyInquiryId || activeInquiry) ? { inquiryId: replyInquiryId || activeInquiry.id, created: false, notify: false } : null);
    const authorLabel = p.authorKind === 'customer'
      ? clip([p.customer.first_name, p.customer.last_name].filter((part) => typeof part === 'string').join(' ').trim(), 128)
      : p.authorLabel;
    const row = q.addMessage.run(p.ns, p.chatId, p.messageId, conversation?.id ?? null, link?.inquiryId ?? null,
      p.connectionId ?? null, p.direction, p.authorKind, authorLabel, content.kind, content.text, content.fileId,
      content.fileUniqueId, p.replyTo, p.link ?? null, unixStamp(safeInt(message.date)),
      edited ? unixStamp(safeInt(message.edit_date)) : null, historical ? 1 : 0, stamp());
    return result('stored', p.direction === 'in' ? 'inbound' : 'outbound', {
      messageRowId: Number(row.lastInsertRowid),
      conversationId: conversation?.id ?? null,
      inquiryId: link?.inquiryId ?? null,
      notifyInquiryId: link?.notify ? link.inquiryId : null
    });
  }

  function handleDeleted(event) {
    if (!plain(event) || !plain(event.chat) || !Array.isArray(event.message_ids)) return result('rejected', 'malformed');
    const { account, error } = businessAccount(event.business_connection_id);
    if (error) return result('rejected', error);
    const chatId = tgId(event.chat.id);
    const ids = event.message_ids.slice(0, MAX_DELETE_IDS).map(safeInt);
    if (!chatId || ids.some((id) => !id || id < 1)) return result('rejected', 'malformed');
    const at = stamp();
    let marked = 0;
    // История не удаляется: сохраняется факт и время удаления, содержимое остаётся для разбора.
    for (const id of ids) marked += Number(q.markDeleted.run(at, `biz:${account.ownerUserId}`, chatId, id).changes);
    return result('stored', 'deleted_marked', { marked });
  }

  function handleConnection(event) {
    if (!plain(event) || typeof event.id !== 'string' || !plain(event.user)) return result('rejected', 'malformed');
    const known = cfg.connections.get(event.id);
    if (!known) return result('rejected', 'unknown_business_connection');
    if (tgId(event.user.id) !== known.ownerUserId) return result('rejected', 'forged_business_owner');
    const canReply = plain(event.rights) ? event.rights.can_reply === true : event.can_reply === true;
    q.saveConnection.run(known.id, known.ownerUserId, event.is_enabled === true ? 1 : 0, canReply ? 1 : 0, stamp());
    return result('stored', event.is_enabled === true ? 'business_connection_enabled' : 'business_connection_revoked');
  }

  function route(update, historical) {
    if (update.message !== undefined) return handleMessage(update.message, { business: false, edited: false, historical });
    if (update.edited_message !== undefined) return handleMessage(update.edited_message, { business: false, edited: true, historical });
    if (update.business_message !== undefined) return handleMessage(update.business_message, { business: true, edited: false, historical });
    if (update.edited_business_message !== undefined) {
      return handleMessage(update.edited_business_message, { business: true, edited: true, historical });
    }
    if (historical) return result('ignored', 'historical_only_messages');
    if (update.deleted_business_messages !== undefined) return handleDeleted(update.deleted_business_messages);
    if (update.business_connection !== undefined) return handleConnection(update.business_connection);
    if (update.message_reaction !== undefined || update.message_reaction_count !== undefined) return result('ignored', 'reaction');
    return result('ignored', 'unsupported_update');
  }

  function trusted(meta) {
    if (!plain(meta) || meta.capability !== capability) fail(403, 'Приём Telegram доступен только штатному обработчику хоста');
  }

  /**
   * ingress 'webhook': вызывать из существующего обработчика webhook ПОСЛЕ проверки X-Telegram-Bot-Api-Secret-Token,
   *   meta.webhookSecretVerified === true.
   * ingress 'polling': вызывать из существующего единственного getUpdates-диспетчера хоста для полного update
   *   (с update_id), полученного им по HTTPS от Bot API своим токеном: meta.polledByHost === true.
   * Флаги разных режимов не взаимозаменяемы; собственного polling/webhook модуль не запускает.
   */
  function receive(update, meta) {
    trusted(meta);
    if (cfg.ingress === 'webhook' && (meta.webhookSecretVerified !== true || meta.polledByHost !== undefined)) {
      fail(403, 'Хост не подтвердил подпись webhook');
    }
    if (cfg.ingress === 'polling' && (meta.polledByHost !== true || meta.webhookSecretVerified !== undefined)) {
      fail(403, 'Обновление не получено штатным диспетчером getUpdates хоста');
    }
    if (!plain(update)) return result('rejected', 'malformed');
    const updateId = safeInt(update.update_id);
    if (updateId === null || updateId < 0) return result('rejected', 'malformed');
    return atomic(() => {
      const seen = q.seenUpdate.get(cfg.botId, updateId);
      if (seen) return result('duplicate', 'update_already_processed', { previous: seen.outcome });
      const outcome = route(update, false);
      q.addUpdate.run(cfg.botId, updateId, `${outcome.status}:${outcome.reason}`, stamp());
      return outcome;
    });
  }

  /**
   * Перенос истории из доверенного экспорта хоста (не из браузера). Только сообщения; update_id не нужен.
   * Каждое сообщение — отдельная транзакция; уведомления и напоминания не создаются.
   */
  function importHistorical(updates, meta) {
    trusted(meta);
    if (!Array.isArray(updates)) fail(400, 'Нужен массив сообщений');
    const summary = { stored: 0, duplicate: 0, ignored: 0, rejected: 0 };
    for (const update of updates) {
      const outcome = plain(update) ? atomic(() => route(update, true)) : result('rejected', 'malformed');
      summary[outcome.status] = (summary[outcome.status] || 0) + 1;
    }
    return summary;
  }

  /** Для существующего worker уведомлений хоста. Исторические обращения сюда не попадают. */
  function pendingNotifications(meta, limit = 50) {
    trusted(meta);
    const size = Number.isSafeInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
    return db.prepare(`SELECT i.id inquiryId,i.status,i.intent,c.source,c.post_link postLink
      FROM tg_ingest_inquiries i JOIN tg_ingest_conversations c ON c.id=i.conversation_id
      WHERE i.notify_state='pending' AND i.status IN ('new','review','accepted')
      ORDER BY i.id LIMIT ?`).all(size).map((row) => ({ ...row }));
  }

  /** Отмечать только после подтверждённой доставки существующим транспортом. */
  function markNotified(inquiryId, meta) {
    trusted(meta);
    const changes = Number(db.prepare(`UPDATE tg_ingest_inquiries SET notify_state='notified',updated_at=?
      WHERE id=? AND notify_state='pending'`).run(stamp(), Number(inquiryId)).changes);
    return { ok: changes === 1 };
  }

  /**
   * Краткая карточка обращения для связи с CRM Palitra (только серверный код хоста).
   * Без username/телефона: стабильный TG user ID, отображаемое имя, первое входящее сообщение и ссылка на пост.
   */
  function inquirySnapshot(inquiryId, meta) {
    trusted(meta);
    const row = db.prepare(`SELECT i.id,i.status,i.intent,i.historical,i.notify_state notifyState,i.created_at createdAt,
        c.source,c.post_link postLink,cu.tg_user_id customerTgId,cu.display_name customerName
      FROM tg_ingest_inquiries i JOIN tg_ingest_conversations c ON c.id=i.conversation_id
      LEFT JOIN tg_ingest_customers cu ON cu.id=i.customer_id WHERE i.id=?`).get(Number(inquiryId));
    if (!row) return null;
    const first = db.prepare(`SELECT kind,text FROM tg_ingest_messages WHERE inquiry_id=? AND direction='in' ORDER BY sent_at,id LIMIT 1`).get(row.id);
    const summary = first ? (first.text || ({ photo: 'Фото', voice: 'Голосовое сообщение', video: 'Видео', video_note: 'Видеосообщение',
      audio: 'Аудио', document: 'Файл', sticker: 'Стикер', animation: 'Анимация', contact: 'Контакт', location: 'Геопозиция' }[first.kind] || 'Сообщение')) : '';
    return { ...row, historical: row.historical === 1, summary };
  }

  // --- Действия сотрудников. actor формирует хост из проверенной сессии (crm-access.resolve), не из JSON.
  function staff(actor) {
    if (!plain(actor) || actor.companyCode !== COMPANY || !['owner', 'admin'].includes(actor.role)
      || typeof actor.id !== 'string' || !actor.id.trim()) fail(403, 'Действие доступно сотруднику Palitra');
    return actor.id.trim().slice(0, 128);
  }
  const inquiryOf = (value) => {
    const id = Number(value);
    const row = Number.isSafeInteger(id) && id > 0 ? q.inquiry.get(id) : null;
    if (!row) fail(404, 'Обращение не найдено');
    return row;
  };

  function listInquiries(actor, { status = null, includeHistorical = true } = {}) {
    staff(actor);
    if (status !== null && !Object.hasOwn(DECISIONS, status)) fail(400, 'Неизвестный статус');
    return db.prepare(`SELECT i.id,i.status,i.intent,i.historical,i.notify_state notifyState,
        i.edited_after_decision editedAfterDecision,i.order_id orderId,i.created_at createdAt,i.updated_at updatedAt,
        c.source,c.post_link postLink,cu.tg_user_id customerTgId,cu.display_name customerName,
        (SELECT count(*) FROM tg_ingest_messages m WHERE m.inquiry_id=i.id) messages,
        (SELECT count(*) FROM tg_ingest_messages m WHERE m.inquiry_id=i.id AND m.deleted_at IS NOT NULL) deletedMessages
      FROM tg_ingest_inquiries i JOIN tg_ingest_conversations c ON c.id=i.conversation_id
      LEFT JOIN tg_ingest_customers cu ON cu.id=i.customer_id
      WHERE (? IS NULL OR i.status=?) AND (?=1 OR i.historical=0) ORDER BY i.id DESC`)
      .all(status, status, includeHistorical ? 1 : 0).map((row) => ({ ...row }));
  }

  function conversation(inquiryId, actor) {
    staff(actor);
    const inquiry = inquiryOf(inquiryId);
    const messages = db.prepare(`SELECT id,direction,author_kind authorKind,author_label authorLabel,kind,text,
        file_id IS NOT NULL hasFile,link,sent_at sentAt,edited_at editedAt,deleted_at deletedAt,historical,
        (SELECT count(*) FROM tg_ingest_revisions r WHERE r.message_row_id=m.id) revisions
      FROM tg_ingest_messages m WHERE conversation_id=? ORDER BY sent_at,id`).all(inquiry.conversation_id);
    return { inquiry: { ...inquiry }, messages: messages.map((row) => ({ ...row })) };
  }

  function decide(inquiryId, decision, actor) {
    const by = staff(actor);
    return atomic(() => {
      const inquiry = inquiryOf(inquiryId);
      if (!DECISIONS[inquiry.status].includes(decision)) fail(409, 'Такое изменение статуса недоступно');
      const at = stamp();
      const changes = db.prepare(`UPDATE tg_ingest_inquiries SET status=?,decided_by=?,decided_at=?,updated_at=?
        WHERE id=? AND status=?`).run(decision, by, at, at, inquiry.id, inquiry.status).changes;
      if (Number(changes) !== 1) fail(409, 'Обращение изменилось, обновите карточку');
      q.audit.run(inquiry.id, `status:${decision}`, by, inquiry.status, at);
      return { ok: true, inquiryId: inquiry.id, status: decision };
    });
  }

  /**
   * Связь подтверждённой заявки с существующим заказом. Права на заказ проверяет workspace хоста.
   * Связь не означает оплату: статус оплаты остаётся только в workspace.
   */
  function linkOrder(inquiryId, orderId, actor) {
    const by = staff(actor);
    if (typeof authorizeOrderLink !== 'function') fail(503, 'Связь с заказами не подключена');
    const order = Number(orderId);
    if (!Number.isSafeInteger(order) || order < 1) fail(404, 'Заказ не найден');
    return atomic(() => {
      const inquiry = inquiryOf(inquiryId);
      if (inquiry.status !== 'accepted') fail(409, 'Сначала подтвердите заявку');
      if (inquiry.order_id !== null && inquiry.order_id !== order) fail(409, 'Заявка уже связана с другим заказом');
      if (inquiry.order_id === order) return { ok: true, inquiryId: inquiry.id, orderId: order, created: false };
      if (authorizeOrderLink({ inquiryId: inquiry.id, orderId: order, actor }) !== true) fail(403, 'Нет доступа к заказу');
      const at = stamp();
      db.prepare('UPDATE tg_ingest_inquiries SET order_id=?,updated_at=? WHERE id=? AND order_id IS NULL').run(order, at, inquiry.id);
      q.audit.run(inquiry.id, 'order:link', by, String(order), at);
      return { ok: true, inquiryId: inquiry.id, orderId: order, created: true };
    });
  }

  return {
    ingress: Object.freeze({ capability, receive, importHistorical, pendingNotifications, markNotified, inquirySnapshot }),
    crm: Object.freeze({ listInquiries, conversation, decide, linkOrder })
  };
}

module.exports = { createTelegramIngest, normalizeConfig, classify, COMPANY };
