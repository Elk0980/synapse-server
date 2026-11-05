'use strict';

/* Palitra PhaseB: серверный адаптер общего чата сайта к native Synapse (14.10.2026).

   Связывает принятое ядро customer-chat.js (repair R1 добавил только recordDeliveryReceipt) с тем, что уже есть на сервере:
   - одна центральная SQLite и ОДНА транзакция хоста (projectChat.transaction) для заявки, ядра чата, диалогов и очереди;
   - одна очередь client_bot_outbox и один существующий worker/мост: копия менеджеру — kind 'forward', копия клиенту —
     kind 'reply'; legacy dialog_id/message_id/reply_to_operator_message = NULL; jobRef ядра — настоящий 'cb:<outbox.id>';
   - chat_native_jobs — только типизированная связь задания очереди с чатом и сообщением ядра (FK), не вторая очередь;
   - проверки перед выдачей (бот, точный адресат, автор) и исходы (ACK, срок аренды, остановки) — в той же транзакции.
   Поддельных номеров Telegram, client_dialogs и legacy-сообщений для гостя нет.
   PALITRA-WEBCHAT-PHASED1: восемь native видов вложений (настоящий mediaOf client-dialogs) — в общую историю ядра;
   байты скачивает существующий мост (pendingThreadDownloads → /attachment?id=thread:N); копии — copyMessage только
   сохранённого источника того же бота, адресат — действующий менеджер или подтверждённый канал клиента. Правка
   media-сообщения — событие ядра. Копия своего сообщения с сайта клиенту в Telegram включена для Palitra (M1).

   Закрытые функции клиентского бота (бот, менеджер, мост, постановка в очередь) адаптер получает один раз через
   createClientDialogs({ chatIntegration: adapter.attach }) и наружу их не выдаёт. */

const { createCustomerChat } = require('./customer-chat.js');
const mediaKit = require('./customer-chat-media.cjs');
/* PALITRA-WEBCHAT-PHASEE: журнал загрузок с сайта/из приложения создаётся здесь один раз (после таблиц ядра и прежних
   диалогов) и передаётся ядру и client-dialogs. Задание файла — та же очередь: части sendPhoto/sendDocument строятся
   только из журнала (метод, размер, хеш, имя, тип) и проверенного адресата; новые загрузки — только при uploadsEnabled. */
const uploadKit = require('./customer-chat-upload.cjs');

const SITE = 'palitra';
const COMPANY = 'palitra-love';
const JOB_PREFIX = 'cb:';
const FLUSH_LIMIT = 20;
const TELEGRAM_ID = /^[1-9]\d{0,19}$/;

const MAPPING_DDL = `
  CREATE TABLE IF NOT EXISTS chat_native_jobs (
    job_id INTEGER PRIMARY KEY REFERENCES client_bot_outbox(id),
    bot_key TEXT NOT NULL,
    company_code TEXT NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
    message_id INTEGER NOT NULL REFERENCES chat_thread_messages(id),
    target TEXT NOT NULL CHECK(target IN ('manager','customer')),
    created_at TEXT NOT NULL,
    UNIQUE(message_id, target)
  );
  CREATE INDEX IF NOT EXISTS chat_native_jobs_bot ON chat_native_jobs(bot_key, job_id);
`;

// Причины остановки задания до отправки: понятный текст в очереди, без персональных данных.
const STOP_REASONS = Object.freeze({
  CHAT_DISABLED: 'Чат сайта выключен до отправки',
  BOT_DISABLED: 'Клиентский бот отключён до отправки',
  BOT_CHANGED: 'Клиентский бот изменён до отправки',
  OPERATOR_CHANGED: 'Менеджер изменён или отключён до отправки',
  CHANNEL_INACTIVE: 'Telegram клиента переключён на другой чат до отправки',
  CHANNEL_CHANGED: 'Адресат в Telegram изменён до отправки',
  OWNER_REVOKED: 'Доступ автора ответа изменился до отправки',
  MISMATCH: 'Задание чата сайта не совпадает с записью доставки',
  NOT_FOUND: 'Доставка чата сайта не найдена',
  NOT_QUEUED: 'Доставка чата сайта уже завершена',
  SOURCE_CHANGED: 'Сообщение изменено в Telegram до отправки — копируется новая версия',
});
const TEXTS = Object.freeze({
  // PHASED1: фото, голосовые, видео, файлы и стикеры принимаются; эти ответы — только для прочих видов (опрос, кубик и т. п.).
  customerTextOnly: 'Такой тип сообщения в чат заявки не передаётся. Отправьте текст, фото, файл, видео или голосовое.',
  managerTextOnly: 'Такой тип сообщения клиенту чата сайта не передаётся. Ответьте текстом, фото, файлом, видео или голосовым.',
  editIgnored: 'Исправления сообщений в этом чате не передаются. Отправьте уточнение отдельным сообщением.',
  linkRefused: 'Ссылка из чата сайта устарела или уже использована. Откройте чат заявки на сайте и нажмите «Продолжить в Telegram» ещё раз.',
});
const linkedText = (bot, orderId) => [
  `Готово: этот чат продолжает переписку${orderId ? ` по заявке №${orderId}` : ''} с сайта ${bot && bot.title ? bot.title : 'магазина'}.`,
  'Пишите здесь — менеджер ответит. Сообщения с сайта остаются в чате на сайте.',
].join('\n');

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const positive = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
const refOf = (jobId) => `${JOB_PREFIX}${jobId}`;
const typed = (action, threadId, threadMessageId) => ({ ok: true, action, threadId: threadId ?? null, threadMessageId: threadMessageId ?? null, messageIds: [] });

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db   центральная SQLite
 * @param {(fn:Function)=>any} options.transaction          projectChat.transaction (вложенный вызов — внутри той же)
 * @param {object} options.siteOrders                        projectChat.siteOrders (orderSummary)
 * @param {(userId:number, sessionVersion:number)=>boolean} options.ownerStillValid
 * @param {string[]} options.origins                         точные одобренные адреса магазина (parseShop)
 * @param {boolean} options.enabled                          PALITRA_CUSTOMER_CHAT_ENABLED === 'true'
 */
function createCustomerChatNative({ db, transaction, siteOrders, ownerStillValid, origins, enabled = false, now = Date.now, uploadsEnabled = false } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('createCustomerChatNative: нужен db');
  if (typeof transaction !== 'function') throw new TypeError('createCustomerChatNative: нужна общая транзакция хоста');
  if (!siteOrders || typeof siteOrders.orderSummary !== 'function') throw new TypeError('createCustomerChatNative: нужен siteOrders');
  if (!Array.isArray(origins) || !origins.length) throw new TypeError('createCustomerChatNative: нужны адреса магазина');
  const on = enabled === true;
  // PHASEE: выключатель новых загрузок (по умолчанию выключен; включает Root после обновления единственного моста).
  const uploadsOn = uploadsEnabled === true;
  let api = null, core = null, hooks = null, uploads = null;
  const requireCore = () => core || fail(503, 'Чат сайта не подключён', 'CHAT_NOT_READY');
  const mappingOf = (jobId) => db.prepare('SELECT * FROM chat_native_jobs WHERE job_id=?').get(jobId) || null;

  /* ---------- постановка копии в существующую очередь (вызывает ядро внутри своей транзакции) ---------- */
  function nativeEnqueue(job) {
    if (!on) fail(503, 'Чат сайта выключен', 'CHAT_DISABLED');
    if (!job || job.site !== SITE || !['sendMessage', 'copyMessage', 'upload'].includes(job.method) || !['manager', 'customer'].includes(job.target)) fail(400, 'Некорректное задание чата сайта', 'JOB');
    const found = api.botForSite(SITE);
    if (!found || !found.enabled || found.key !== job.botKey) fail(409, 'Клиентский бот изменён', 'BOT_CHANGED');
    const chatId = String(job.chatId ?? '');
    const copying = job.method === 'copyMessage', filing = job.method === 'upload';
    if (!TELEGRAM_ID.test(chatId) || typeof job.text !== 'string' || (!copying && !filing && !job.text)) fail(400, 'Некорректное задание чата сайта', 'JOB');
    const thread = db.prepare('SELECT id, site, company_code FROM chat_threads WHERE id=?').get(job.threadId);
    const message = db.prepare('SELECT id, thread_id FROM chat_thread_messages WHERE id=?').get(job.messageId);
    if (!thread || thread.site !== SITE || thread.company_code !== COMPANY || !message || message.thread_id !== thread.id) fail(409, 'Чат задания не найден', 'JOB_SCOPE');
    // Адресат — только настоящий: текущий действующий менеджер либо активный подтверждённый канал этого чата.
    if (job.target === 'manager') {
      const operator = api.activeOperator(found.key);
      if (!operator || operator.telegram_user_id !== chatId) fail(409, 'Менеджер бота изменён', 'OPERATOR_CHANGED');
    } else if (!db.prepare("SELECT 1 FROM chat_thread_channels WHERE thread_id=? AND bot_key=? AND chat_id=? AND status='active'").get(thread.id, found.key, chatId)) {
      fail(409, 'Telegram клиента изменён', 'CHANNEL_CHANGED');
    }
    // PHASED1: копия вложения — copyMessage только сохранённого источника этой записи того же бота (не из тела задания).
    let parts = null;
    if (copying) {
      const source = requireCore().copySource(message.id);
      if (!source || source.botKey !== found.key || !job.copy || String(job.copy.fromChatId ?? '') !== source.chatId || job.copy.messageId !== source.messageId) {
        fail(409, 'Источник копии не совпадает с сообщением чата', 'COPY_SOURCE');
      }
      parts = [...(job.text ? api.textParts(chatId, job.text) : []),
        { method: 'copyMessage', params: { chat_id: chatId, from_chat_id: source.chatId, message_id: source.messageId } }];
    }
    // PHASEE: файл с сайта/из приложения — часть sendPhoto/sendDocument только из завершённой загрузки ЭТОГО сообщения;
    // у веб-байтов нет источника Telegram: ни copyMessage, ни поддельных номеров. Подпись ≤ 1024 (иначе — текстом выше).
    if (filing) {
      const row = uploads ? uploads.forThreadMessage(message.id) : null;
      const caption = job.upload && typeof job.upload.caption === 'string' ? job.upload.caption : null;
      if (!row || row.thread_id !== thread.id || !job.upload || job.upload.ref !== uploadKit.uploadRef(row.upload_uuid) || caption === null
        || caption.length > uploadKit.MEDIA_CAPTION) fail(409, 'Файл задания не совпадает с сообщением чата', 'UPLOAD_SOURCE');
      parts = [...(job.text ? api.textParts(chatId, job.text) : []), uploads.filePart(row, { chatId, caption })];
    }
    const id = api.enqueue(found.key, job.target === 'manager' ? 'forward' : 'reply', {
      parts: parts || api.textParts(chatId, job.text), after: [], dialogId: null, messageId: null, replyToOperatorMessage: null,
      // Менеджерская копия помечается менеджером: при его смене прежний механизм очереди её останавливает.
      operatorId: job.target === 'manager' ? chatId : null,
    });
    db.prepare('INSERT INTO chat_native_jobs(job_id,bot_key,company_code,thread_id,message_id,target,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, found.key, COMPANY, thread.id, message.id, job.target, api.stamp());
    return refOf(id);
  }

  /* ---------- синхронизация исхода задания очереди с журналом доставок ядра ---------- */
  function onSettled(job, status, error, ids) {
    const mapping = job ? mappingOf(job.id) : null;
    // Только своё задание: та же связь, тот же бот; чужие и legacy-строки сюда не попадают.
    if (!mapping || mapping.bot_key !== job.bot_key || mapping.company_code !== COMPANY) return;
    const jobRef = refOf(job.id);
    const externalMessageIds = Array.isArray(ids) ? ids.map(String) : [];
    // pending/sending (разрешённый повтор до отправки) — в чате прежнее «в очереди», но уже подтверждённые части сразу
    // попадают в квитанцию и карту ответов менеджера (repair R1): ответ на первую часть не теряется.
    // Только в пределах этого задания: та же запись доставки (сообщение и чат связи), тот же бот и тот же адресат частей.
    if (status === 'pending' || status === 'sending') {
      if (!externalMessageIds.length) return;
      const delivery = db.prepare('SELECT message_id, bot_key, target_chat_id FROM chat_message_deliveries WHERE job_ref=?').get(jobRef);
      const message = delivery ? db.prepare('SELECT thread_id FROM chat_thread_messages WHERE id=?').get(delivery.message_id) : null;
      let parts = [];
      try { parts = JSON.parse(job.parts || '[]'); } catch (_) { parts = []; }
      if (!delivery || !message || delivery.message_id !== mapping.message_id || message.thread_id !== mapping.thread_id || delivery.bot_key !== job.bot_key
        || !parts.length || parts.some((part) => String(part?.params?.chat_id ?? '') !== String(delivery.target_chat_id ?? ''))) return;
      requireCore().recordDeliveryReceipt({ jobRef, externalMessageIds: externalMessageIds.slice(0, parts.length) });
    } else if (status === 'sent') requireCore().acknowledgeDelivery({ jobRef, ok: true, externalMessageIds });
    else if (status === 'uncertain') requireCore().acknowledgeDelivery({ jobRef, ok: false, uncertain: true, error: String(error || ''), externalMessageIds });
    else if (status === 'failed') requireCore().acknowledgeDelivery({ jobRef, ok: false, error: String(error || ''), externalMessageIds });
  }
  function dispatchGuard(job) {
    const mapping = job ? mappingOf(job.id) : null;
    if (!mapping) return null;
    if (!on) return { allowed: false, reason: STOP_REASONS.CHAT_DISABLED };
    if (mapping.bot_key !== job.bot_key || mapping.company_code !== COMPANY) return { allowed: false, reason: STOP_REASONS.MISMATCH };
    const delivery = db.prepare('SELECT target_chat_id FROM chat_message_deliveries WHERE job_ref=?').get(refOf(job.id));
    let parts = [];
    try { parts = JSON.parse(job.parts || '[]'); } catch (_) { parts = []; }
    // PHASED1: copyMessage — только из сохранённого источника этой записи того же бота; прочие методы не выдаются.
    const source = parts.some((part) => part?.method === 'copyMessage') ? requireCore().copySource(mapping.message_id) : null;
    const wrongCopy = (part) => part.method === 'copyMessage' && (!source || source.botKey !== job.bot_key
      || String(part.params?.from_chat_id ?? '') !== source.chatId || part.params?.message_id !== source.messageId);
    // PHASEE: файловая часть — ровно одна и ровно та, что строится из завершённой загрузки этого сообщения.
    const isFile = (part) => Object.hasOwn(uploadKit.FILE_METHODS, part?.method);
    const fileRow = parts.some(isFile) && uploads ? uploads.forThreadMessage(mapping.message_id) : null;
    const wrongFile = (part) => isFile(part) && !(fileRow && fileRow.thread_id === mapping.thread_id && uploads.partMatches(part, fileRow));
    if (!delivery || !parts.length || parts.filter(isFile).length > 1 || parts.some((part) => !(['sendMessage', 'copyMessage'].includes(part?.method) || isFile(part))
      || String(part?.params?.chat_id ?? '') !== String(delivery.target_chat_id ?? '') || wrongCopy(part) || wrongFile(part))) {
      return { allowed: false, reason: STOP_REASONS.MISMATCH };
    }
    const verdict = requireCore().deliveryAllowed(refOf(job.id));
    return verdict.allowed ? { allowed: true, reason: '' } : { allowed: false, reason: STOP_REASONS[verdict.reason] || 'Копия чата сайта остановлена до отправки' };
  }
  /* PHASEE: байты файла моста (upload-source) — только для задания этого сообщения чата с этой загрузкой, пока задание
     ещё разрешено (тот же бот, адресат, канал или менеджер, действующий автор-владелец, без смены источника). */
  function uploadJobAllowed(job, row) {
    const mapping = job ? mappingOf(job.id) : null;
    if (!mapping || !row || row.target_kind !== 'thread' || mapping.message_id !== row.thread_message_id || mapping.thread_id !== row.thread_id
      || mapping.bot_key !== job.bot_key || mapping.company_code !== COMPANY) return false;
    const guard = dispatchGuard(job);
    return Boolean(guard && guard.allowed);
  }
  function beforeOutbox(key) {
    if (!on) return;
    const found = api.botForSite(SITE);
    if (!found || found.key !== key) return;
    requireCore().flushNotQueued({ site: SITE, limit: FLUSH_LIMIT });
  }

  /* ---------- приём Telegram до прежнего пути (внутри транзакции receive) ---------- */
  /* PHASED1: описание вложения — из настоящего mediaOf client-dialogs (тот же выбор размера фото и предел 20 МБ);
     file_id остаётся внутри сервера. Признаки стикера и media_group_id — только из самого update. */
  function descriptorOf(message) {
    const found = message ? api.mediaOf(message) : null;
    if (!found || !found.item || typeof found.item.file_id !== 'string') return null;
    const item = found.item;
    return { kind: found.kind, fileId: item.file_id, fileUniqueId: typeof item.file_unique_id === 'string' ? item.file_unique_id : '',
      mime: found.mime, name: found.name, size: positive(item.file_size) || null,
      flags: { animated: found.kind === 'sticker' && item.is_animated === true, video: found.kind === 'sticker' && item.is_video === true,
        groupId: typeof message.media_group_id === 'string' ? message.media_group_id : null } };
  }
  function managerReply({ key, message, chatId, messageId, text }) {
    const replyTo = positive(message?.reply_to_message?.message_id);
    if (!replyTo) return null;
    const result = requireCore().receiveManagerTelegramReply({ botKey: key, operatorTelegramId: chatId, chatId, messageId,
      replyToMessageId: replyTo, text, media: descriptorOf(message) });
    if (!result.routed) return null;
    if (!result.stored) {
      api.notice(key, chatId, TEXTS.managerTextOnly, { replyTo: messageId });
      api.audit(key, 'site_chat_unsupported', 'operator', `чат №${result.threadId}: не текст`);
      return typed('site_chat_unsupported', result.threadId, null);
    }
    return typed(result.duplicate ? 'site_chat_duplicate' : 'site_chat_reply', result.threadId, result.messageId);
  }
  function claimStart({ key, bot, chatId, payload }) {
    const result = requireCore().claimTelegramLink({ botKey: key, startPayload: payload, telegramUserId: chatId, chatId });
    if (result.claimed) {
      if (!result.duplicate) {
        const orderId = db.prepare('SELECT order_id FROM chat_threads WHERE id=?').get(result.threadId)?.order_id ?? null;
        api.notice(key, chatId, linkedText(bot, orderId));
        api.audit(key, 'site_chat_linked', `telegram:${chatId}`, `чат №${result.threadId}${result.previousThreadId ? `; прежний чат №${result.previousThreadId} отключён от Telegram` : ''}`);
      }
      return typed(result.duplicate ? 'site_chat_link_duplicate' : 'site_chat_linked', result.threadId, null);
    }
    // Распознанная, но неверная или устаревшая ссылка c_ в прежний путь не уходит: диалог не создаётся.
    api.notice(key, chatId, TEXTS.linkRefused);
    api.audit(key, 'site_chat_link_refused', `telegram:${chatId}`, String(result.reason || 'UNKNOWN'));
    return typed('site_chat_link_refused', null, null);
  }
  function customerMessage({ key, message, chatId, messageId, text }) {
    const result = requireCore().receiveTelegramCustomerMessage({ botKey: key, telegramUserId: chatId, chatId, messageId, text, media: descriptorOf(message) });
    if (!result.routed) return null;
    if (!result.stored) {
      api.notice(key, chatId, TEXTS.customerTextOnly, { replyTo: messageId });
      api.audit(key, 'site_chat_unsupported', `telegram:${chatId}`, `чат №${result.threadId}: не текст`);
      return typed('site_chat_unsupported', result.threadId, null);
    }
    return typed(result.duplicate ? 'site_chat_duplicate' : 'site_chat_message', result.threadId, result.messageId);
  }
  function editedMessage({ key, chatId, messageId, message = null, editDate = 0, text = '', replay = false }) {
    const row = db.prepare('SELECT id, thread_id FROM chat_thread_messages WHERE bot_key=? AND tg_chat_id=? AND tg_message_id=?').get(key, String(chatId), Number(messageId));
    if (!row) return null;
    /* Repair R2: повтор уже принятой правки (квитанция client-dialogs) — только сверка с существующим событием ядра:
       то же содержимое — повтор, другое — конфликт. Новое событие, уведомление и задание здесь не создаются. */
    if (replay) {
      const result = message ? requireCore().replayTelegramEdit({ botKey: key, chatId, messageId, editDate, text, media: descriptorOf(message) }) : null;
      if (!result || !result.event) return null;
      if (result.conflict) {
        api.audit(key, 'site_chat_edit_conflict', `telegram:${chatId}`, `чат №${result.threadId}: тот же ключ правки с другим содержимым`);
        return typed('site_chat_edit_conflict', result.threadId, result.messageId);
      }
      return typed('site_chat_edit_duplicate', result.threadId, result.messageId);
    }
    // PHASED1: правка сообщения с вложением — отдельное событие ядра (новая версия), прежняя версия остаётся.
    if (message) {
      const result = requireCore().receiveTelegramEdit({ botKey: key, chatId, messageId, editDate, text, media: descriptorOf(message) });
      if (result.routed && result.event) {
        if (result.conflict) {
          api.audit(key, 'site_chat_edit_conflict', `telegram:${chatId}`, `чат №${result.threadId}: тот же ключ правки с другим содержимым`);
          return typed('site_chat_edit_conflict', result.threadId, result.messageId);
        }
        if (!result.duplicate) api.audit(key, 'site_chat_edit', `telegram:${chatId}`, `чат №${result.threadId}${result.replaced ? ': новый файл' : ': новая подпись'}`);
        return typed(result.duplicate ? 'site_chat_edit_duplicate' : 'site_chat_edit', result.threadId, result.messageId);
      }
    }
    api.notice(key, chatId, TEXTS.editIgnored, { replyTo: messageId });
    api.audit(key, 'site_chat_edit_ignored', `telegram:${chatId}`, `чат №${row.thread_id}`);
    return typed('site_chat_edit_ignored', row.thread_id, row.id);
  }

  /* ---------- подключение к client-dialogs (один раз) ---------- */
  function attach(privateApi) {
    if (api) throw new Error('createCustomerChatNative: адаптер уже подключён');
    for (const name of ['botForSite', 'activeOperator', 'bridgeState', 'enqueue', 'textParts', 'mediaOf', 'notice', 'audit', 'stamp']) {
      if (typeof privateApi?.[name] !== 'function') throw new TypeError(`createCustomerChatNative: нет функции клиентского бота ${name}`);
    }
    api = privateApi;
    const storage = typeof privateApi.storageRoot === 'string' ? mediaKit.createMediaStorage({ root: privateApi.storageRoot, now }) : null;
    const legacyBytes = () => { try { const n = typeof privateApi.legacyStorageBytes === 'function' ? Number(privateApi.legacyStorageBytes()) : 0; return Number.isFinite(n) && n > 0 ? n : 0; } catch (_) { return 0; } };
    core = createCustomerChat({
      db, transact: transaction, now,
      sites: { [SITE]: { companyCode: COMPANY, origins } },
      // Чат сайта включается отдельно: выключенный флаг — бот «не подключён» для ядра (новых копий нет, ожидающие останавливаются).
      botForSite: (site) => {
        if (site !== SITE) return null;
        const found = api.botForSite(site);
        return found ? { key: found.key, enabled: Boolean(found.enabled) && on } : null;
      },
      activeOperator: (key) => api.activeOperator(key),
      bridgeReady: (key) => on && api.bridgeState(key).ready === true,
      ownerStillValid,
      enqueue: nativeEnqueue,
      orderExists: (site, orderId) => site === SITE && Boolean(siteOrders.orderSummary(site, orderId)),
      // PHASED1 (M1): только для фиксированной Palitra — копия своего сообщения с сайта в подтверждённый Telegram клиента.
      mirrorCustomerWebToTelegram: true,
      // PHASED1: тот же приватный каталог вложений, что у прежних диалогов (свои UUID-имена), и тот же общий предел.
      // PHASEE: «прежние» байты для D — это L + E (загрузки), чтобы общий предел был один: L + D + E.
      media: storage ? {
        storage, maxFile: privateApi.maxFile, maxStorage: privateApi.maxStorage,
        legacyBytes: () => legacyBytes() + (uploads ? uploads.bytes() : 0),
      } : null,
      // PHASEE: журнал создаётся ниже (после таблиц ядра); новые загрузки чата сайта — только при включённых чате и загрузках.
      webUploads: () => uploads,
      webUploadsEnabled: () => on && uploadsOn,
      ownerLegacyRequestUsed: (ownerId, requestId) => typeof privateApi.ownerRequestUsed === 'function' && privateApi.ownerRequestUsed(ownerId, requestId) === true,
    });
    db.exec(MAPPING_DDL);
    // PHASEE: один журнал на чат сайта и прежние диалоги; учёт E видит L + D, D и legacy видят E через свои обратные вызовы.
    uploads = storage ? uploadKit.createWebUploads({ db, transact: transaction, storage, now, maxFile: privateApi.maxFile, maxStorage: privateApi.maxStorage,
      otherBytes: () => legacyBytes() + (core ? core.mediaBytes() : 0) }) : null;
    hooks = Object.freeze({ isTyped: (job) => Boolean(job && mappingOf(job.id)), dispatchGuard, onSettled, beforeOutbox,
      managerReply, claimStart, customerMessage, editedMessage,
      pendingThreadDownloads, saveThreadAttachment, markThreadAttachment,
      // D + E: прежний подсчёт client-dialogs (storageUsed = L + это) видит и вложения Telegram, и загрузки.
      mediaBytes: () => (core ? core.mediaBytes() : 0) + (uploads ? uploads.bytes() : 0),
      // PHASEE: файлы владельца в прежние диалоги — тот же журнал и тот же выключатель; пространство requestId текста чата.
      uploads, uploadsEnabled: () => uploadsOn && Boolean(uploads), uploadJobAllowed,
      threadRequestUsed: (actorRef, requestId) => (core ? core.textRequestUsed('owner', actorRef, requestId) : false) });
    return hooks;
  }

  /* ---------- PHASED1: вложения для существующего моста (внутренние маршруты client-dialogs, ключ службы — server.js) ---------- */
  const ourBot = (key) => { const found = api.botForSite(SITE); return Boolean(found && found.key === key); };
  // Что скачать по результату приёма (в том числе повторного): только ожидающие вложения этой записи этого бота.
  function pendingThreadDownloads(key, result) {
    if (!core || !ourBot(key) || !result || typeof result.action !== 'string' || !result.action.startsWith('site_chat_')) return [];
    const messageId = positive(result.threadMessageId);
    return messageId ? core.pendingDownloads({ botKey: key, messageId }) : [];
  }
  function saveThreadAttachment(key, ref, bytes) {
    if (!ourBot(key)) fail(404, 'Вложение не найдено', 'NOT_FOUND');
    return requireCore().saveAttachment({ botKey: key, attachmentId: ref, bytes });
  }
  function markThreadAttachment(key, ref, status, error) {
    if (!ourBot(key)) fail(404, 'Вложение не найдено', 'NOT_FOUND');
    return requireCore().markAttachment({ botKey: key, attachmentId: ref, status, error });
  }

  /* ---------- заявка сайта: одна native-заявка и чат в одной транзакции ---------- */
  /* chatRequest — { site, origin, cookie, csrf } из настоящих заголовков запроса (customer-chat-http.orderContext) или null.
     submit — ровно один вызов native siteOrders.submit. 201 → новый чат и доступ этой сессии; 200 duplicate → только
     уже имеющийся доступ этой сессии; honeypot 200 без orderId — без чата. Любая ошибка откатывает заявку и чат вместе. */
  function submitWithChat({ chatRequest = null, submit } = {}) {
    if (typeof submit !== 'function') throw new TypeError('submitWithChat: нужен submit');
    if (chatRequest && (!on || !core)) fail(409, 'Чат сайта сейчас недоступен — заявка не отправлена, корзина сохранена', 'CHAT_DISABLED');
    return transaction(() => {
      const result = submit();
      if (!chatRequest || !result || !result.body) return { result, chat: null };
      const orderId = result.body.orderId;
      try {
        if (result.status === 201 && Number.isSafeInteger(orderId) && orderId > 0) {
          const { thread } = core.createNewOrderThread(chatRequest, { orderId });
          return { result, chat: { threadId: thread.id } };
        }
        if (result.status === 200 && result.body.duplicate === true && Number.isSafeInteger(orderId) && orderId > 0) {
          const { thread } = core.findOwnedOrder(chatRequest, { orderId });
          return { result, chat: thread ? { threadId: thread.id } : null };
        }
      } catch (error) {
        if (error && error.status) error.chat = true;
        throw error;
      }
      return { result, chat: null };
    });
  }

  /* ---------- приложение владельца (проверки сессии/Origin/CSRF — в server.js) ---------- */
  const owner = Object.freeze({
    list: ({ owner: who, before, limit }) => requireCore().ownerListThreads({ site: SITE, owner: who, before, limit }),
    read: ({ owner: who, threadId, before, limit }) => requireCore().ownerReadThread({ site: SITE, owner: who, threadId, before, limit }),
    reply: ({ owner: who, threadId, requestId, text }) => requireCore().ownerReply({ site: SITE, owner: who, body: { threadId, requestId, text } }),
    // PHASED1: защищённое чтение файла владельцем (проверка владельца — в ядре, повторно — в server.js перед байтами).
    attachment: ({ owner: who, threadId, attachmentId }) => requireCore().ownerAttachment({ site: SITE, owner: who, threadId, attachmentId }),
    openAttachment: (meta) => requireCore().openAttachment(meta),
    // PHASEE: файл владельца в чат сайта (Origin/CSRF/свежая сессия — server.js; ownerStillValid — в ядре на каждом шаге).
    prepareUpload: ({ owner: who, threadId, body }) => requireCore().ownerPrepareUpload({ site: SITE, owner: who, threadId, body }),
    uploadStatus: ({ owner: who, threadId, uuid }) => requireCore().ownerUploadStatus({ site: SITE, owner: who, threadId, uuid }),
    beginUpload: ({ owner: who, threadId, uuid }) => requireCore().ownerBeginUpload({ site: SITE, owner: who, threadId, uuid }),
    finishUpload: ({ owner: who, threadId, uuid, claim, bytes }) => requireCore().ownerFinishUpload({ site: SITE, owner: who, threadId, uuid, claim, bytes }),
    uploadFile: ({ owner: who, threadId, uuid }) => requireCore().ownerUploadFile({ site: SITE, owner: who, threadId, uuid }),
    openUpload: (meta) => requireCore().openUpload(meta),
    releaseUpload: (uuid, claim, reason) => requireCore().releaseUpload(uuid, claim, reason),
  });
  /* Карточка заявки → чат сайта: только своя заявка этого сайта; имя и телефон связи не дают. */
  function orderThread(site, orderId) {
    const id = Number(orderId);
    if (site !== SITE || !Number.isSafeInteger(id) || id < 1 || !siteOrders.orderSummary(site, id)) fail(404, 'Заявка не найдена', 'ORDER');
    const row = db.prepare('SELECT id FROM chat_threads WHERE site=? AND company_code=? AND order_id=?').get(SITE, COMPANY, id);
    return { threadId: row ? row.id : null, threadRef: row ? `thread:${row.id}` : null };
  }

  return Object.freeze({ attach, submitWithChat, owner, orderThread, enabled: on, site: SITE,
    // Только серверу и HTTP-модулю: ядро и проверка включения. Не маршрут.
    core: () => requireCore(), isAttached: () => Boolean(api) });
}

module.exports = { createCustomerChatNative, MAPPING_DDL, STOP_REASONS, SITE, COMPANY };
