'use strict';

// Telegram transport only. Room permissions, messages and AI jobs live in content.
const { parseQuietHours, isQuietTime, prepareTelegramPayload } = require('./quiet-hours');

const MAX_FILE = 8 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const SOURCE_MAX_FILE = 20 * 1024 * 1024; // Облачный Bot API getFile, без отдельного сервера API.
const SOURCE_TYPES = new Set([...TYPES, 'video/mp4', 'video/quicktime', 'video/webm']);
const OUTBOX_PER_TICK = 5;
const INBOX_BACKOFF = 300000;
const INBOX_BUDGET = 20;
const ACK_BACKOFF = 120000;
// Комната отвергла именно это событие: повтор того же тела ничего не изменит.
const TERMINAL_STATUS = new Set([400, 404, 409, 413, 415, 422]);
// Вложение не принято по содержимому: текст сообщения всё равно должен дойти.
const FILE_REJECTED = new Set([413, 415]);
const clean = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
// Ответ ИИ в группе подписывается всегда одинаково: участники видят, что пишет бот, а не Влад.
const AI_SIGNATURE = 'Хью, бизнес-ассистент Синапс Бизнес (ИИ)';
// Одна текстовая часть сообщения в Telegram; правка меняет ровно одну такую часть.
const TEXT_PART = 3500;
const EDIT_JOB = /^edit:\d{1,12}$/;
const EDIT_CAPABILITY = 'edit';
// Личное напоминание участнику (specs/083): отдельный вид задания, мост объявляет его явно.
const PERSONAL_JOB = /^personal:\d{1,12}$/;
const PERSONAL_CAPABILITY = 'personal';
const CAPABILITIES = [EDIT_CAPABILITY, PERSONAL_CAPABILITY].join(',');

function createProjectChatBridge({ db, contentUrl, apiKey, telegramToken, legacyHandler, botUsername = '', ownerChatId = '',
  botId = /^\d+:/.test(String(telegramToken || '')) ? String(telegramToken).split(':')[0] : '',
  fetchImpl = (...args) => fetch(...args), quietHours = parseQuietHours(process.env), now = () => new Date() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_telegram_inbox (
    update_id INTEGER PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT,
    chat_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS project_telegram_delivery (
      job_id TEXT NOT NULL, part INTEGER NOT NULL, state TEXT NOT NULL, external_id TEXT,
      PRIMARY KEY(job_id,part));
    CREATE TABLE IF NOT EXISTS project_telegram_ack (
      job_id TEXT PRIMARY KEY, result TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL);`);
  // Очередь событий упорядочена по группам: старшее незавершённое событие держит свои последующие.
  if (!db.prepare('PRAGMA table_info(project_telegram_inbox)').all().some(column => column.name === 'chat_id')) {
    db.exec("ALTER TABLE project_telegram_inbox ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''");
    for (const row of db.prepare("SELECT update_id,body FROM project_telegram_inbox WHERE state='pending'").all()) {
      let chat = '';
      try { chat = String(JSON.parse(row.body)?.message?.chat?.id ?? ''); } catch { chat = ''; }
      db.prepare('UPDATE project_telegram_inbox SET chat_id=? WHERE update_id=?').run(chat, row.update_id);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS project_telegram_inbox_group ON project_telegram_inbox(chat_id,state,update_id);');
  let running = false, timer;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };
  // terminal — комната отказала по содержимому события; остальное считаем временным сбоем службы.
  async function content(route, body) {
    const response = await fetchImpl(`${contentUrl}/content/internal/project-chat${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Сервис комнаты: ${response.status}`),
        { status: response.status, terminal: TERMINAL_STATUS.has(response.status) });
    }
    return response.json();
  }
  /* certain — Bot API явно и определённо отказал (корректный ok:false с кодом 4xx);
     5xx, обрыв сети и нечитаемый ответ означают неизвестный результат: часть могла уйти. */
  async function telegram(method, body) {
    if (!telegramToken) throw Object.assign(new Error('Telegram-бот не подключён'), { certain: true, retryable: false });
    const isForm = body instanceof FormData;
    const prepared = isForm ? body : prepareTelegramPayload(method, body, now(), quietHours);
    if (isForm && !prepared.has('disable_notification') && isQuietTime(now(), quietHours)) {
      prepared.set('disable_notification', 'true');
    }
    const response = await fetchImpl(`https://api.telegram.org/bot${telegramToken}/${method}`, {
      method: 'POST', ...(isForm ? {} : { headers: { 'content-type': 'application/json' } }),
      body: isForm ? prepared : JSON.stringify(prepared), signal: AbortSignal.timeout(40000),
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.ok && payload?.ok) {
      if (method.startsWith('send') && typeof payload.result?.message_id !== 'number') {
        throw Object.assign(new Error('Telegram вернул ответ без номера сообщения'), { certain: false });
      }
      return payload.result;
    }
    const definite = response.status >= 400 && response.status < 500 && payload && payload.ok === false;
    const detail = clean(payload?.description, 120);
    if (!definite) {
      throw Object.assign(new Error(`Telegram: неизвестный результат (${response.status})`), { certain: false });
    }
    throw Object.assign(new Error(`Telegram: ${response.status}${detail ? ` — ${detail}` : ''}`),
      { certain: true, retryable: response.status === 429, description: String(payload?.description ?? ''), status: response.status });
  }
  /* Правка уже отправленного сообщения Хью: ровно один editMessageText тем же ботом, в ту же группу,
     для того же номера сообщения. Ничего не отправляется, не закрепляется и не удаляется.
     ok возвращается только с подтверждением правки именно этого сообщения или с «message is not
     modified» (текст в Telegram уже такой). Правка идемпотентна, поэтому неизвестный исход помечается
     как повторяемый: повтор тем же текстом дубля не создаёт. */
  async function editDelivery(job) {
    const chatId = String(job.chatId ?? ''), messageId = String(job.telegramMessageId ?? '');
    if (!EDIT_JOB.test(String(job.id)) || !/^-?\d{1,20}$/.test(chatId) || !/^\d{1,20}$/.test(messageId)
      || typeof job.text !== 'string' || !job.text.trim()) {
      return { ok: false, uncertain: false, retryable: false, error: 'Некорректное задание правки' };
    }
    const text = `${AI_SIGNATURE}\n${job.text}`;
    if (text.length > TEXT_PART) return { ok: false, uncertain: false, retryable: false, error: 'Текст правки длиннее одной части Telegram' };
    let result;
    try {
      result = await telegram('editMessageText', { chat_id: chatId, message_id: Number(messageId), text });
    } catch (error) {
      if (error.certain && /message is not modified/i.test(String(error.description || ''))) {
        return { ok: true, notModified: true, editedMessageId: messageId, chatId };
      }
      if (error.certain) return { ok: false, uncertain: false, retryable: Boolean(error.retryable), error: clean(error.message, 300) };
      return { ok: false, uncertain: true, retryable: true, error: 'Нет подтверждения правки от Telegram' };
    }
    if (!result || typeof result !== 'object' || String(result.message_id) !== messageId || String(result.chat?.id) !== chatId) {
      return { ok: false, uncertain: true, retryable: true, error: 'Telegram не подтвердил правку именно этого сообщения' };
    }
    return { ok: true, editedMessageId: messageId, chatId };
  }
  /* Личное напоминание от Хью: ровно один sendMessage в личный чат получателя тем же ботом, что пишет в группу.
     Бот задания обязан совпасть с ботом этого моста: разрешение получателя давалось конкретному боту.
     Неизвестный исход не повторяется (сообщение могло уйти); 403 — видимый отказ получателя.
     Ни правок, ни закрепов, ни отправки в группу. */
  async function personalDelivery(job) {
    const chatId = String(job.chatId ?? '');
    if (!PERSONAL_JOB.test(String(job.id)) || !/^[1-9]\d{0,19}$/.test(chatId) || typeof job.text !== 'string' || !job.text.trim()) {
      return { ok: false, uncertain: false, retryable: false, error: 'Некорректное задание личного напоминания' };
    }
    if (!botId || String(job.botId ?? '') !== String(botId)) {
      return { ok: false, uncertain: false, retryable: false, error: 'Разрешение получателя дано другому боту; не отправлено' };
    }
    const text = `${AI_SIGNATURE}\n${job.text}`;
    if (text.length > TEXT_PART) return { ok: false, uncertain: false, retryable: false, error: 'Текст длиннее одного сообщения Telegram' };
    let result;
    try {
      result = await telegram('sendMessage', { chat_id: chatId, text });
    } catch (error) {
      if (error.certain) return { ok: false, uncertain: false, retryable: false, forbidden: error.status === 403, error: clean(error.message, 300) };
      return { ok: false, uncertain: true, retryable: false, error: 'Нет подтверждения отправки от Telegram; повтор не выполняется' };
    }
    if (String(result?.chat?.id ?? '') !== chatId) {
      return { ok: false, uncertain: true, retryable: false, error: 'Telegram не подтвердил доставку именно этому получателю' };
    }
    return { ok: true, messageId: String(result.message_id), chatId };
  }
  function enqueue(update) {
    const message = update.message;
    // Без адреса и ключа комнаты очередь не обслуживается — событие остаётся прежнему обработчику.
    if (!contentUrl || !apiKey || !message || !['group', 'supergroup'].includes(message.chat?.type)) return false;
    if (!Number.isSafeInteger(update.update_id)) throw new Error('Некорректный номер Telegram-события');
    db.prepare('INSERT OR IGNORE INTO project_telegram_inbox(update_id,body,chat_id) VALUES (?,?,?)')
      .run(update.update_id, JSON.stringify(update), String(message.chat.id));
    return true;
  }
  async function attachment(message) {
    const photo = message.photo?.at(-1), doc = message.document;
    const item = photo || doc;
    if (!item) return { files: [], note: '' };
    const mime = photo ? 'image/jpeg' : doc.mime_type;
    if (!TYPES.has(mime) || item.file_size > MAX_FILE) {
      return { files: [], note: '[Вложение доступно в Telegram: поддерживаются фото и PDF до 8 МБ.]' };
    }
    let info;
    try {
      info = await telegram('getFile', { file_id: item.file_id });
    } catch (error) {
      // Определённый отказ Bot API по этому файлу не исправится повтором: сохраняем подпись и пометку.
      if (!error.certain || error.retryable) throw error;
      return { files: [], note: '[Вложение недоступно боту. Откройте его в Telegram.]' };
    }
    if (info.file_size > MAX_FILE || !/^[a-zA-Z0-9_./-]+$/.test(info.file_path || '') || info.file_path.includes('..')) {
      return { files: [], note: '[Вложение доступно в Telegram.]' };
    }
    const response = await fetchImpl(`https://api.telegram.org/file/bot${telegramToken}/${info.file_path}`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    // 4xx — файла уже нет; 5xx и обрыв связи остаются временным сбоем и повторяются.
    if (!response.ok && response.status < 500) return { files: [], note: '[Вложение больше недоступно в Telegram.]' };
    if (!response.ok) throw new Error('Не удалось получить вложение Telegram');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_FILE) { await response.body.cancel?.().catch(() => {}); return { files: [], note: '[Файл больше 8 МБ. Откройте его в Telegram.]' }; }
      chunks.push(Buffer.from(chunk));
    }
    return { files: [{ name: photo ? `photo-${message.message_id}.jpg` : String(doc.file_name || 'document.pdf').slice(0, 180), mime, base64: Buffer.concat(chunks).toString('base64') }], note: '' };
  }
  async function receiveSource(message, source) {
    // Известный источник не передаётся в legacy даже в выключенном состоянии.
    // Оригинальное событие останется в failed inbox для явного повтора после включения.
    if (!source.enabled) throw Object.assign(new Error('Приём исходников выключен; событие сохранено для ручного повтора'), {terminal: true});
    const chatId = String(message.chat.id), messageId = String(message.message_id);
    const receipt = await content(`/source-receipt?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(messageId)}`);
    if (receipt.item) return;
    const photo = message.photo?.at(-1);
    const item = photo || message.video || message.document || message.animation || message.video_note || message.audio || message.voice;
    const event = {chatId, messageId, mediaGroupId: String(message.media_group_id || ''), text: message.text || message.caption || ''};
    if (!item) { if (event.text.trim()) await content('/source-receive', event); return; }
    const mime = photo ? 'image/jpeg' : item.mime_type || (message.video_note ? 'video/mp4' : 'application/octet-stream');
    event.file = {fileId:item.file_id, fileUniqueId:item.file_unique_id, size:item.file_size, mime,
      name:item.file_name || `${photo ? 'photo' : 'source'}-${messageId}${photo ? '.jpg' : ''}`};
    const manual = async reason => content('/source-receive', {...event, status:'manual_import', reason});
    if (item.file_size > SOURCE_MAX_FILE) return manual('Файл больше 20 МБ; нужен ручной импорт из Telegram');
    if (!SOURCE_TYPES.has(mime)) return manual('Формат не поддерживается автоматически; нужен ручной импорт');
    let info;
    try { info = await telegram('getFile', {file_id:item.file_id}); }
    catch (error) {
      if (!error.certain || error.retryable) throw error;
      return manual('Telegram не отдаёт файл через облачный API; нужен ручной импорт');
    }
    if (info.file_size > SOURCE_MAX_FILE) return manual('Файл больше 20 МБ; нужен ручной импорт из Telegram');
    if (!/^[a-zA-Z0-9_./-]+$/.test(info.file_path || '') || info.file_path.includes('..')) return manual('Адрес файла недоступен; нужен ручной импорт');
    const response = await fetchImpl(`https://api.telegram.org/file/bot${telegramToken}/${info.file_path}`, {signal:AbortSignal.timeout(30000),redirect:'error'});
    if (!response.ok && response.status < 500 && response.status !== 429) return manual('Файл недоступен для скачивания; нужен ручной импорт');
    if (!response.ok) throw new Error('Исходник ожидает повторного скачивания');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > SOURCE_MAX_FILE) { await response.body.cancel?.().catch(() => {}); return manual('Файл больше 20 МБ; нужен ручной импорт из Telegram'); }
      chunks.push(Buffer.from(chunk));
    }
    try { await content('/source-receive', {...event,status:'stored',base64:Buffer.concat(chunks).toString('base64')}); }
    catch (error) { if (!FILE_REJECTED.has(error.status)) throw error; return manual('Файл не принят хранилищем; нужен ручной импорт'); }
  }
  async function receive(update) {
    const message = update.message;
    // Свои сообщения и чужие боты не попадают в комнату и не вызывают ответ Хью.
    if (message.from?.is_bot) return;
    const { room, source } = await content(`/binding?chatId=${encodeURIComponent(message.chat.id)}`);
    if (!source && message.migrate_from_chat_id) {
      const previous = await content(`/binding?chatId=${encodeURIComponent(message.migrate_from_chat_id)}`);
      if (previous.source) return content('/source-migrate', {chatId:String(message.migrate_from_chat_id),newChatId:String(message.chat.id)});
    }
    // Источники имеют собственные приватные записи. Никаких команд, задач, AI jobs или outbox.
    if (source) {
      if (message.migrate_to_chat_id) return content('/source-migrate', {chatId:String(message.chat.id),newChatId:String(message.migrate_to_chat_id)});
      return receiveSource(message, source);
    }
    // Перенос группы в супергруппу: служебное событие без содержания, привязку переносит комната.
    if (message.migrate_to_chat_id) {
      await content('/migrate', { chatId: String(message.chat.id), newChatId: String(message.migrate_to_chat_id) });
      return;
    }
    if (!room && message.migrate_from_chat_id) {
      await content('/migrate', { chatId: String(message.migrate_from_chat_id), newChatId: String(message.chat.id) });
      return;
    }
    if (!room) return legacyHandler(update);
    // Команды Хью (/hugh /plan /content /idea /status /help) идут в комнату проекта тем же путём;
    // остальные команды администратора остаются у прежнего обработчика и не сохраняются как сообщения проекта.
    const hughCommand = /^\s*\/(hugh|plan|content|idea|status|help)(?:@([A-Za-z0-9_]{1,64}))?(?:\s|$)/u.exec(message.text || '');
    if (hughCommand) {
      // Команда с адресатом: только нашему боту. Имя бота неизвестно — адресованные команды не принимаем (fail-closed),
      // чтобы комната не отвергала их 400 и обновление не крутилось в очереди.
      if (hughCommand[2] && (!botUsername || hughCommand[2].toLowerCase() !== botUsername.toLowerCase())) return;
      await content('/receive', { chatId: String(message.chat.id), messageId: String(message.message_id),
        authorId: String(message.from?.id || ''), authorName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Участник Telegram',
        text: message.text, command: hughCommand[1] });
      return;
    }
    if (/^\s*\//u.test(message.text || '')) return legacyHandler(update);
    // Адресовано боту: ответ на его сообщение или @упоминание — комната решает, ставить ли вопрос модели.
    // Ответ именно нашему боту: по id из токена или по имени; ответы чужим ботам — не обращение.
    const repliedTo = message.reply_to_message?.from;
    const replyToBot = Boolean(repliedTo?.is_bot && ((botId && String(repliedTo.id) === botId) || (botUsername && String(repliedTo.username || '').toLowerCase() === botUsername.toLowerCase())));
    const mentions = (message.entities || []).filter((e) => e.type === 'mention').map((e) => String(message.text || '').slice(e.offset, e.offset + e.length));
    const addressed = replyToBot || (botUsername && mentions.some((m) => m.replace(/^@/, '').toLowerCase() === botUsername.toLowerCase()));
    const { files, note } = await attachment(message);
    const text = [message.text || message.caption || '', note].filter(Boolean).join('\n');
    if (!text && !files.length) return;
    const event = {
      chatId: String(message.chat.id), messageId: String(message.message_id),
      authorId: String(message.from?.id || message.sender_chat?.id || ''),
      authorName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || message.sender_chat?.title || 'Участник Telegram',
      text, files, addressed: Boolean(addressed),
    };
    try {
      await content('/receive', event);
    } catch (error) {
      // Комната не приняла сам файл — сохраняем подпись и пометку, чтобы сообщение не пропало.
      if (!files.length || !FILE_REJECTED.has(error.status)) throw error;
      const marker = '[Вложение не принято: файл не распознан. Откройте его в Telegram.]';
      await content('/receive', { ...event, files: [],
        text: [event.text, marker].filter(Boolean).join('\n') });
    }
  }
  async function delivery(job) {
    if (job.kind === 'edit') return editDelivery(job);
    if (job.kind === 'personal') return personalDelivery(job);
    if (job.audience === 'owner') {
      if (!/^owner-alert:\d+$/.test(String(job.id)) || !/^\d+$/.test(String(ownerChatId))) {
        return { ok:false,retryable:false,uncertain:false,error:'Личный Telegram владельца не настроен' };
      }
      job = { ...job,chatId:String(ownerChatId),attachments:[] };
    }
    const prefix = `${job.authorType === 'assistant' ? AI_SIGNATURE : (job.authorName || 'Участник')}\n`;
    const full = prefix + (job.text || '');
    const parts = [];
    if ((job.text || '').trim() || !job.attachments?.length) {
      for (let start = 0; start < full.length; start += TEXT_PART) parts.push({ text: full.slice(start, start + TEXT_PART) });
    }
    for (const file of job.attachments || []) parts.push({ file });
    const ids = [];
    for (let index = 0; index < parts.length; index++) {
      const existing = db.prepare('SELECT * FROM project_telegram_delivery WHERE job_id=? AND part=?').get(String(job.id), index);
      // Уже отправленная часть не повторяется ни при повторной попытке, ни после перезапуска.
      if (existing?.state === 'sent') { ids.push(existing.external_id); continue; }
      if (existing?.state === 'sending' || existing?.state === 'uncertain') {
        return { ok: false, uncertain: true, error: 'Telegram мог принять сообщение. Повторная отправка остановлена, чтобы избежать дубля.', externalMessageIds: ids };
      }
      let body, method;
      // All local preparation finishes before marking a network attempt uncertain.
      if (parts[index].file) {
        const file = await content(`/attachment?id=${encodeURIComponent(parts[index].file.id)}&companyCode=${encodeURIComponent(job.companyCode)}`);
        body = new FormData(); body.set('chat_id', job.chatId); body.set('caption', prefix.trim());
        const field = file.mime.startsWith('image/') ? 'photo' : 'document';
        body.set(field, new Blob([Buffer.from(file.base64, 'base64')], { type: file.mime }), file.name);
        method = field === 'photo' ? 'sendPhoto' : 'sendDocument';
      } else { body = { chat_id: job.chatId, text: parts[index].text }; method = 'sendMessage'; }
      db.prepare("INSERT INTO project_telegram_delivery(job_id,part,state) VALUES (?,?,'sending') ON CONFLICT(job_id,part) DO UPDATE SET state='sending'").run(String(job.id), index);
      try {
        const result = await telegram(method, body);
        db.prepare("UPDATE project_telegram_delivery SET state='sent',external_id=? WHERE job_id=? AND part=?").run(String(result.message_id), String(job.id), index);
        ids.push(String(result.message_id));
      } catch (error) {
        db.prepare('UPDATE project_telegram_delivery SET state=? WHERE job_id=? AND part=?').run(error.certain ? 'failed' : 'uncertain', String(job.id), index);
        if (!error.certain) {
          return { ok: false, uncertain: true, retryable: false,
            error: 'Нет подтверждения доставки Telegram; автоматический повтор остановлен.', externalMessageIds: ids };
        }
        return { ok: false, uncertain: false, retryable: Boolean(error.retryable),
          error: clean(error.message, 300), externalMessageIds: ids };
      }
    }
    return { ok: true, externalMessageIds: ids };
  }
  /* Голова каждой группы: старейшее незавершённое событие. Пока оно не завершено — в том числе
     когда ждёт паузу после временного сбоя — следующие события той же группы не обрабатываются.
     Другие группы при этом идут своим ходом. */
  function inboxHeads(moment) {
    return db.prepare(`SELECT p.* FROM project_telegram_inbox p
      WHERE p.state='pending' AND p.retry_at<=?
        AND NOT EXISTS (SELECT 1 FROM project_telegram_inbox o
          WHERE o.state='pending' AND o.chat_id=p.chat_id AND o.update_id<p.update_id)
      ORDER BY p.update_id LIMIT ?`).all(moment, INBOX_BUDGET);
  }
  // true — событие завершено (принято или отклонено), голова группы сдвигается.
  async function handleInbox(row) {
    let update;
    try { update = JSON.parse(row.body); }
    catch {
      db.prepare("UPDATE project_telegram_inbox SET state='failed',error=? WHERE update_id=?")
        .run('Событие Telegram не разбирается', row.update_id);
      return true;
    }
    try {
      await receive(update);
      db.prepare("UPDATE project_telegram_inbox SET state='done',body='{}',error=NULL WHERE update_id=?").run(row.update_id);
      return true;
    } catch (error) {
      const attempts = row.attempts + 1;
      if (error.terminal) {
        // Комната отказала по содержимому: повтор не поможет, тело сохраняем для разбора владельцем.
        db.prepare("UPDATE project_telegram_inbox SET state='failed',attempts=?,error=? WHERE update_id=?")
          .run(attempts, clean(error.message, 200), row.update_id);
        console.error(`project-chat: событие Telegram ${row.update_id} отклонено комнатой: ${clean(error.message, 120)}`);
        return true;
      }
      // Временный сбой службы: повторяем бесконечно с ограниченной паузой, событие не теряется.
      db.prepare('UPDATE project_telegram_inbox SET attempts=?,retry_at=?,error=? WHERE update_id=?')
        .run(attempts, Date.now() + Math.min(INBOX_BACKOFF, 5000 * 2 ** Math.min(row.attempts, 6)),
          'Ожидает повторной синхронизации', row.update_id);
      return false;
    }
  }
  async function drainInbox() {
    let budget = INBOX_BUDGET;
    while (budget > 0) {
      const heads = inboxHeads(Date.now());
      if (!heads.length) return;
      let moved = false;
      for (const row of heads) {
        if (budget <= 0) break;
        budget -= 1;
        if (await handleInbox(row)) moved = true;
      }
      if (!moved) return;
    }
  }

  /* Результат доставки сохраняется до обращения к комнате: даже если подтверждение не дошло,
     известный исход не теряется и будет повторён без повторной отправки в Telegram. */
  function queueAck(jobId, result) {
    db.prepare(`INSERT INTO project_telegram_ack(job_id,result,retry_at,created_at) VALUES(?,?,0,?)
      ON CONFLICT(job_id) DO UPDATE SET result=excluded.result`).run(String(jobId), JSON.stringify(result), Date.now());
    return db.prepare('SELECT * FROM project_telegram_ack WHERE job_id=?').get(String(jobId));
  }
  async function flushAck(row) {
    const numeric = Number(row.job_id);
    try {
      await content('/acknowledge', { jobId: Number.isSafeInteger(numeric) ? numeric : row.job_id, ...JSON.parse(row.result) });
      db.prepare('DELETE FROM project_telegram_ack WHERE job_id=?').run(row.job_id);
      return true;
    } catch (error) {
      if (error.terminal) {
        // Комната не знает такой отправки: повторять подтверждение больше некуда.
        db.prepare('DELETE FROM project_telegram_ack WHERE job_id=?').run(row.job_id);
        console.error(`project-chat: подтверждение отправки ${row.job_id} отклонено комнатой: ${clean(error.message, 120)}`);
        return true;
      }
      db.prepare('UPDATE project_telegram_ack SET attempts=attempts+1,retry_at=? WHERE job_id=?')
        .run(Date.now() + Math.min(ACK_BACKOFF, 2000 * 2 ** Math.min(row.attempts, 6)), row.job_id);
      return false;
    }
  }
  async function flushAcks() {
    const rows = db.prepare('SELECT * FROM project_telegram_ack WHERE retry_at<=? ORDER BY created_at,job_id LIMIT ?')
      .all(Date.now(), INBOX_BUDGET);
    for (const row of rows) if (!await flushAck(row)) return false;
    return !db.prepare('SELECT 1 FROM project_telegram_ack LIMIT 1').get();
  }
  async function drainOutbox() {
    // Комната выдаёт по одному заданию: срок аренды не истекает во время последовательных частей.
    for (let index = 0; index < OUTBOX_PER_TICK; index++) {
      let jobs;
      // Мост объявляет правку: без этого флага комната заданий правки не выдаёт.
      try { ({ jobs } = await content(`/outbox?capabilities=${CAPABILITIES}`)); } catch { return; }
      if (!jobs?.length) return;
      for (const job of jobs) {
        // Правка без своего номера edit:N не квитируется: числовой номер принадлежит обычной отправке.
        if (job.kind === 'edit' && !EDIT_JOB.test(String(job.id))) continue;
        if (job.kind === 'personal' && !PERSONAL_JOB.test(String(job.id))) continue;
        let result;
        try { result = await delivery(job); }
        catch (error) {
          // Отправка не начиналась: подготовка вложения — локальный шаг, повтор безопасен.
          result = { ok: false, uncertain: false, retryable: !error.terminal,
            error: clean(error.terminal ? error.message : 'Не удалось подготовить вложение к отправке', 300) };
        }
        // Сначала фиксируем исход, затем сообщаем его комнате.
        if (!await flushAck(queueAck(job.id, result))) return;
      }
    }
  }
  async function tick() {
    if (running || !contentUrl || !apiKey) return;
    running = true;
    try {
      // Незавершённые подтверждения возвращаются комнате раньше новых отправок.
      const acknowledged = await flushAcks();
      await drainInbox();
      if (acknowledged) await drainOutbox();
    } finally { running = false; }
  }
  return {
    enqueue, tick, delivery, receive,
    // Незавершённые подтверждения доставки: видны владельцу и переживают перезапуск.
    pendingAcks: () => db.prepare('SELECT job_id,result,attempts FROM project_telegram_ack ORDER BY created_at,job_id')
      .all().map(row => ({ jobId: Number(row.job_id), attempts: Number(row.attempts), result: JSON.parse(row.result) })),
    // Диагностика владельца: отклонённые события видны и возвращаются в очередь вручную.
    failedInbox: (limit = 20) => db.prepare("SELECT update_id,attempts,error FROM project_telegram_inbox WHERE state='failed' ORDER BY update_id LIMIT ?")
      .all(Math.max(1, Math.min(Number(limit) || 20, 100))),
    retryInbox: (updateId) => {
      if (!Number.isSafeInteger(Number(updateId))) throw new Error('Некорректный номер Telegram-события');
      const result = db.prepare("UPDATE project_telegram_inbox SET state='pending',attempts=0,retry_at=0,error=NULL WHERE update_id=? AND state='failed' AND body<>'{}'")
        .run(Number(updateId));
      return { ok: Number(result.changes) > 0 };
    },
    getOffset: () => db.prepare('SELECT offset FROM telegram_checkpoint WHERE id=1').get()?.offset,
    saveOffset: offset => db.prepare('INSERT INTO telegram_checkpoint(id,offset) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset').run(offset),
    start() { timer = setInterval(() => void tick().catch(() => {}), 3000); timer.unref(); void tick().catch(() => {}); },
    stop() { clearInterval(timer); },
  };
}
module.exports = { createProjectChatBridge, AI_SIGNATURE, TEXT_PART, CAPABILITIES };
