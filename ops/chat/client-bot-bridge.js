'use strict';

/* Транспорт клиентского Telegram-бота компании (сейчас — Palitra). Только Telegram: приём событий,
   скачивание вложений, отправка заданий и подтверждения. Диалоги, правила ответа и права живут в content
   (ops/content/client-dialogs.js); туда мост ходит по внутреннему ключу службы.

   Отдельно от бота Synapse и общего чата проекта: свой токен, своя очередь событий, своя отметка
   getUpdates (checkpoint), свои состояния доставки. Принимаются только личные чаты; группы, каналы
   и прочие события не сохраняются.

   Надёжность — как у моста общего чата: событие сначала записывается в очередь и только потом
   подтверждается Telegram; неизвестный исход отправки (обрыв, 5xx, ответ без message_id) никогда
   не повторяется автоматически; уже отправленная часть задания не отправляется второй раз. */

const crypto = require('node:crypto');
const { parseQuietHours, isQuietTime } = require('./quiet-hours');

const DEFAULT_MAX_FILE = 20 * 1024 * 1024;
const OUTBOX_PER_TICK = 5;
const INBOX_BUDGET = 20;
const INBOX_BACKOFF = 300000;
const ACK_BACKOFF = 120000;
const TERMINAL_STATUS = new Set([400, 404, 409, 413, 415, 422]);
// Мост отправляет только эти методы Bot API: задание из content не может вызвать ничего другого.
const SEND_METHODS = new Set(['sendMessage', 'copyMessage']);
const AFTER_METHODS = new Set(['setMessageReaction']);
const QUIET_METHODS = new Set(['sendMessage', 'copyMessage']);
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'];
// Лимиты входящих событий по умолчанию: на один чат и на весь бот. Проверяются до записи в очередь.
const DEFAULT_LIMITS = Object.freeze({ perChatMinute: 20, perChatDay: 300, perBotHour: 1000 });
const VERIFY_EVERY = 60 * 1000;                       // повторная проверка getMe и подтверждение готовности в content
const LIMIT_NOTICE = 'Слишком много сообщений подряд. Подождите немного: сообщения сверх лимита не сохраняются и менеджеру не передаются.';
// Паузы фонового цикла не держат процесс: остановка сервиса и тесты не ждут их окончания.
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const clean = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);

function createClientBotBridge({ db, botKey, token, expectedUsername = '', contentUrl, apiKey, webhookSecret = '', polling = false,
  fetchImpl = (...args) => fetch(...args), quietHours = parseQuietHours(process.env), now = () => new Date(),
  maxFile = DEFAULT_MAX_FILE, limits = {}, log = console }) {
  const limit = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, value]) => Number.isSafeInteger(value) && value > 0)) };
  const expected = String(expectedUsername || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(botKey || ''))) throw new Error('Некорректный ключ клиентского бота');
  db.exec(`CREATE TABLE IF NOT EXISTS client_bot_inbox (
      bot_key TEXT NOT NULL, update_id INTEGER NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, chat_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(bot_key, update_id));
    CREATE INDEX IF NOT EXISTS client_bot_inbox_group ON client_bot_inbox(bot_key, chat_id, state, update_id);
    CREATE TABLE IF NOT EXISTS client_bot_delivery (
      bot_key TEXT NOT NULL, job_id TEXT NOT NULL, part INTEGER NOT NULL, state TEXT NOT NULL, external_id TEXT,
      PRIMARY KEY(bot_key, job_id, part));
    CREATE TABLE IF NOT EXISTS client_bot_ack (
      bot_key TEXT NOT NULL, job_id TEXT NOT NULL, result TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(bot_key, job_id));
    CREATE TABLE IF NOT EXISTS client_bot_checkpoint (bot_key TEXT PRIMARY KEY, offset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS client_bot_rate (bot_key TEXT NOT NULL, chat_id TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS client_bot_rate_chat ON client_bot_rate(bot_key, chat_id, at);
    CREATE INDEX IF NOT EXISTS client_bot_rate_bot ON client_bot_rate(bot_key, at);
    CREATE TABLE IF NOT EXISTS client_bot_dropped (bot_key TEXT NOT NULL, update_id INTEGER NOT NULL, chat_id TEXT NOT NULL,
      reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(bot_key, update_id));
    CREATE TABLE IF NOT EXISTS client_bot_limit_notice (bot_key TEXT NOT NULL, chat_id TEXT NOT NULL, until INTEGER NOT NULL,
      PRIMARY KEY(bot_key, chat_id));`);
  let running = false, timer, stopped = false;
  // Готовность: токен проверен getMe и относится к ожидаемому боту. До этого мост ничего не отправляет и не опрашивает.
  let verified = { ok: false, at: 0, error: 'ещё не проверено' };
  const headers = { 'x-api-key': apiKey };
  const internal = (route) => `${contentUrl}/content/internal/client-bot${route}${route.includes('?') ? '&' : '?'}botKey=${encodeURIComponent(botKey)}`;

  async function content(route, body, { raw = false } = {}) {
    const response = await fetchImpl(internal(route), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Сервис диалогов: ${response.status}`),
        { status: response.status, terminal: TERMINAL_STATUS.has(response.status) });
    }
    return response.json();
  }

  /* certain — Bot API явно отказал (ok:false с кодом 4xx); остальное — неизвестный результат. */
  async function telegram(method, body) {
    if (!token) throw Object.assign(new Error('Клиентский бот не подключён'), { certain: true, retryable: false });
    const prepared = { ...body };
    if (QUIET_METHODS.has(method) && prepared.disable_notification === undefined && isQuietTime(now(), quietHours)) prepared.disable_notification = true;
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prepared), signal: AbortSignal.timeout(40000),
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.ok && payload?.ok) {
      if (SEND_METHODS.has(method) && typeof payload.result?.message_id !== 'number') {
        throw Object.assign(new Error('Telegram вернул ответ без номера сообщения'), { certain: false });
      }
      return payload.result;
    }
    const definite = response.status >= 400 && response.status < 500 && payload && payload.ok === false;
    const detail = clean(payload?.description, 120);
    if (!definite) throw Object.assign(new Error(`Telegram: неизвестный результат (${response.status})`), { certain: false });
    throw Object.assign(new Error(`Telegram: ${response.status}${detail ? ` — ${detail}` : ''}`), { certain: true, retryable: response.status === 429 });
  }

  /* ---------- приём ---------- */
  function chatOf(update) {
    const message = update?.message || update?.edited_message;
    if (message) return message.chat?.type === 'private' ? String(message.chat.id ?? '') : null;
    const query = update?.callback_query;
    if (query) return query.message?.chat?.type === 'private' ? String(query.message.chat.id ?? '') : null;
    return null;
  }
  /* true — событие сохранено (или уже было); false — не наше (группа, канал, иной тип) и не хранится. */
  /* Лимиты: считаются только новые события. Повтор того же update_id (webhook, getUpdates) не тратит лимит
     второй раз: принятое остаётся принятым, отброшенное — отброшенным. Сверх лимита событие не пишется в очередь. */
  function enqueue(update) {
    if (!Number.isSafeInteger(update?.update_id)) throw new Error('Некорректный номер Telegram-события');
    const chat = chatOf(update);
    if (!chat) return false;
    if (db.prepare('SELECT 1 FROM client_bot_inbox WHERE bot_key=? AND update_id=?').get(botKey, update.update_id)) return true;
    if (db.prepare('SELECT 1 FROM client_bot_dropped WHERE bot_key=? AND update_id=?').get(botKey, update.update_id)) return false;
    const at = now().getTime();
    db.prepare('DELETE FROM client_bot_rate WHERE bot_key=? AND at<?').run(botKey, at - 24 * 60 * 60 * 1000);
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;
    const reason = count('SELECT count(*) AS n FROM client_bot_rate WHERE bot_key=? AND chat_id=? AND at>=?', botKey, chat, at - 60 * 1000) >= limit.perChatMinute ? 'chat_minute'
      : count('SELECT count(*) AS n FROM client_bot_rate WHERE bot_key=? AND chat_id=? AND at>=?', botKey, chat, at - 24 * 60 * 60 * 1000) >= limit.perChatDay ? 'chat_day'
        : count('SELECT count(*) AS n FROM client_bot_rate WHERE bot_key=? AND at>=?', botKey, at - 60 * 60 * 1000) >= limit.perBotHour ? 'bot_hour' : '';
    if (reason) {
      db.prepare('INSERT OR IGNORE INTO client_bot_dropped(bot_key,update_id,chat_id,reason,at) VALUES (?,?,?,?,?)').run(botKey, update.update_id, chat, reason, at);
      // Отправителю — одно короткое объяснение за окно, не на каждое сообщение (без очереди и без ИИ).
      const notified = db.prepare('SELECT until FROM client_bot_limit_notice WHERE bot_key=? AND chat_id=?').get(botKey, chat);
      if (verified.ok && update.message && (!notified || notified.until <= at)) {
        db.prepare(`INSERT INTO client_bot_limit_notice(bot_key,chat_id,until) VALUES(?,?,?)
          ON CONFLICT(bot_key,chat_id) DO UPDATE SET until=excluded.until`).run(botKey, chat, at + 60 * 60 * 1000);
        void telegram('sendMessage', { chat_id: chat, text: LIMIT_NOTICE }).catch(() => {});
      }
      log.warn?.(`client-bot ${botKey}: событие ${update.update_id} отброшено лимитом ${reason}`);
      return false;
    }
    db.prepare('INSERT INTO client_bot_inbox(bot_key,update_id,body,chat_id) VALUES (?,?,?,?)').run(botKey, update.update_id, JSON.stringify(update), chat);
    db.prepare('INSERT INTO client_bot_rate(bot_key,chat_id,at) VALUES (?,?,?)').run(botKey, chat, at);
    return true;
  }
  /* Вложение скачивается с сервера Telegram и передаётся в content; ссылка с токеном наружу не выходит. */
  async function download(item) {
    let info;
    try { info = await telegram('getFile', { file_id: item.fileId }); }
    catch (error) {
      if (!error.certain || error.retryable) throw error;
      return content('/attachment-status', { attachmentId: item.attachmentId, status: /too big/i.test(error.message) ? 'too_large' : 'unavailable',
        error: /too big/i.test(error.message) ? 'Файл больше предела Bot API' : 'Telegram не отдал файл боту' });
    }
    if (Number(info?.file_size) > maxFile) return content('/attachment-status', { attachmentId: item.attachmentId, status: 'too_large', error: 'Файл слишком большой' });
    if (!/^[a-zA-Z0-9_./-]+$/.test(info?.file_path || '') || info.file_path.includes('..')) {
      return content('/attachment-status', { attachmentId: item.attachmentId, status: 'unavailable', error: 'Некорректный путь файла' });
    }
    const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok && response.status < 500) return content('/attachment-status', { attachmentId: item.attachmentId, status: 'unavailable', error: 'Файл больше недоступен в Telegram' });
    if (!response.ok) throw new Error('Не удалось получить вложение Telegram');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxFile) {
        await response.body.cancel?.().catch(() => {});
        return content('/attachment-status', { attachmentId: item.attachmentId, status: 'too_large', error: 'Файл слишком большой' });
      }
      chunks.push(Buffer.from(chunk));
    }
    return content(`/attachment?id=${encodeURIComponent(item.attachmentId)}`, Buffer.concat(chunks), { raw: true });
  }
  async function receive(update) {
    if (update.callback_query) {
      const query = update.callback_query;
      const result = await content('/callback', { callback: query });
      // Ответ на нажатие и правка сообщения — не критичны: сбой не повторяет обработку кнопки.
      try { await telegram('answerCallbackQuery', { callback_query_id: String(query.id), text: clean(result.answer?.text, 180), show_alert: Boolean(result.answer?.showAlert) }); }
      catch (error) { log.warn?.(`client-bot ${botKey}: ответ на кнопку не принят: ${clean(error.message, 120)}`); }
      if (result.edit) {
        try { await telegram('editMessageText', { chat_id: result.edit.chatId, message_id: result.edit.messageId, text: result.edit.text, reply_markup: result.edit.replyMarkup }); }
        catch (error) { log.warn?.(`client-bot ${botKey}: сообщение заявки не обновлено: ${clean(error.message, 120)}`); }
      }
      return;
    }
    const payload = update.message ? { message: update.message } : { edited_message: update.edited_message };
    const result = await content('/receive', { update: payload });
    for (const item of result.downloads || []) await download(item);
  }
  function inboxHeads(moment) {
    return db.prepare(`SELECT p.* FROM client_bot_inbox p
      WHERE p.bot_key=? AND p.state='pending' AND p.retry_at<=?
        AND NOT EXISTS (SELECT 1 FROM client_bot_inbox o
          WHERE o.bot_key=p.bot_key AND o.state='pending' AND o.chat_id=p.chat_id AND o.update_id<p.update_id)
      ORDER BY p.update_id LIMIT ?`).all(botKey, moment, INBOX_BUDGET);
  }
  async function handleInbox(row) {
    let update;
    try { update = JSON.parse(row.body); }
    catch {
      db.prepare("UPDATE client_bot_inbox SET state='failed',error=? WHERE bot_key=? AND update_id=?").run('Событие Telegram не разбирается', botKey, row.update_id);
      return true;
    }
    try {
      await receive(update);
      db.prepare("UPDATE client_bot_inbox SET state='done',body='{}',error=NULL WHERE bot_key=? AND update_id=?").run(botKey, row.update_id);
      return true;
    } catch (error) {
      const attempts = row.attempts + 1;
      if (error.terminal) {
        db.prepare("UPDATE client_bot_inbox SET state='failed',attempts=?,error=? WHERE bot_key=? AND update_id=?").run(attempts, clean(error.message, 200), botKey, row.update_id);
        log.error?.(`client-bot ${botKey}: событие ${row.update_id} отклонено службой диалогов: ${clean(error.message, 120)}`);
        return true;
      }
      db.prepare('UPDATE client_bot_inbox SET attempts=?,retry_at=?,error=? WHERE bot_key=? AND update_id=?')
        .run(attempts, Date.now() + Math.min(INBOX_BACKOFF, 5000 * 2 ** Math.min(row.attempts, 6)), 'Ожидает повторной обработки', botKey, row.update_id);
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

  /* ---------- отправка ---------- */
  async function delivery(job) {
    const jobId = String(job.id);
    const parts = Array.isArray(job.parts) ? job.parts : [];
    if (!parts.length || parts.some((part) => !SEND_METHODS.has(part?.method) || !part.params || typeof part.params !== 'object')) {
      return { ok: false, uncertain: false, retryable: false, error: 'Некорректное задание отправки', externalMessageIds: [] };
    }
    const ids = [];
    for (let index = 0; index < parts.length; index++) {
      const existing = db.prepare('SELECT * FROM client_bot_delivery WHERE bot_key=? AND job_id=? AND part=?').get(botKey, jobId, index);
      if (existing?.state === 'sent') { ids.push(existing.external_id); continue; }
      if (existing?.state === 'sending' || existing?.state === 'uncertain') {
        return { ok: false, uncertain: true, error: 'Telegram мог принять сообщение. Повторная отправка остановлена, чтобы избежать дубля.', externalMessageIds: ids };
      }
      db.prepare("INSERT INTO client_bot_delivery(bot_key,job_id,part,state) VALUES (?,?,?,'sending') ON CONFLICT(bot_key,job_id,part) DO UPDATE SET state='sending'")
        .run(botKey, jobId, index);
      try {
        const result = await telegram(parts[index].method, parts[index].params);
        db.prepare("UPDATE client_bot_delivery SET state='sent',external_id=? WHERE bot_key=? AND job_id=? AND part=?").run(String(result.message_id), botKey, jobId, index);
        ids.push(String(result.message_id));
      } catch (error) {
        db.prepare('UPDATE client_bot_delivery SET state=? WHERE bot_key=? AND job_id=? AND part=?').run(error.certain ? 'failed' : 'uncertain', botKey, jobId, index);
        if (!error.certain) return { ok: false, uncertain: true, retryable: false, error: 'Нет подтверждения доставки Telegram; автоматический повтор остановлен.', externalMessageIds: ids };
        return { ok: false, uncertain: false, retryable: Boolean(error.retryable), error: clean(error.message, 300), externalMessageIds: ids };
      }
    }
    // Дополнительные шаги (отметка 👌 на ответе менеджера) не влияют на исход доставки.
    for (const step of Array.isArray(job.after) ? job.after : []) {
      if (!AFTER_METHODS.has(step?.method)) continue;
      try { await telegram(step.method, step.params); }
      catch (error) { log.warn?.(`client-bot ${botKey}: дополнительный шаг ${step.method} не выполнен: ${clean(error.message, 120)}`); }
    }
    return { ok: true, externalMessageIds: ids };
  }
  function queueAck(jobId, result) {
    db.prepare(`INSERT INTO client_bot_ack(bot_key,job_id,result,retry_at,created_at) VALUES(?,?,?,0,?)
      ON CONFLICT(bot_key,job_id) DO UPDATE SET result=excluded.result`).run(botKey, String(jobId), JSON.stringify(result), Date.now());
    return db.prepare('SELECT * FROM client_bot_ack WHERE bot_key=? AND job_id=?').get(botKey, String(jobId));
  }
  async function flushAck(row) {
    try {
      await content('/acknowledge', { jobId: row.job_id, ...JSON.parse(row.result) });
      db.prepare('DELETE FROM client_bot_ack WHERE bot_key=? AND job_id=?').run(botKey, row.job_id);
      return true;
    } catch (error) {
      if (error.terminal) {
        db.prepare('DELETE FROM client_bot_ack WHERE bot_key=? AND job_id=?').run(botKey, row.job_id);
        log.error?.(`client-bot ${botKey}: подтверждение ${row.job_id} отклонено: ${clean(error.message, 120)}`);
        return true;
      }
      db.prepare('UPDATE client_bot_ack SET attempts=attempts+1,retry_at=? WHERE bot_key=? AND job_id=?')
        .run(Date.now() + Math.min(ACK_BACKOFF, 2000 * 2 ** Math.min(row.attempts, 6)), botKey, row.job_id);
      return false;
    }
  }
  async function flushAcks() {
    const rows = db.prepare('SELECT * FROM client_bot_ack WHERE bot_key=? AND retry_at<=? ORDER BY created_at,job_id LIMIT ?').all(botKey, Date.now(), INBOX_BUDGET);
    for (const row of rows) if (!await flushAck(row)) return false;
    return !db.prepare('SELECT 1 FROM client_bot_ack WHERE bot_key=? LIMIT 1').get(botKey);
  }
  async function drainOutbox() {
    for (let index = 0; index < OUTBOX_PER_TICK; index++) {
      let jobs;
      try { ({ jobs } = await content('/outbox')); } catch { return; }
      if (!jobs?.length) return;
      for (const job of jobs) {
        let result;
        try { result = await delivery(job); }
        catch (error) { result = { ok: false, uncertain: false, retryable: true, error: clean(error.message, 300), externalMessageIds: [] }; }
        if (!await flushAck(queueAck(job.id, result))) return;
      }
    }
  }
  /* getMe: токен действительно относится к ожидаемому боту (а не к боту Synapse или чужому).
     Результат сообщается в content: без свежего успешного подтверждения ссылки в Telegram не выдаются. */
  async function verify() {
    let result;
    try {
      const me = await telegram('getMe', {});
      const username = String(me?.username || '');
      result = expected && username.toLowerCase() === expected
        ? { ok: true, username, botId: String(me.id ?? ''), error: '' }
        : { ok: false, username, botId: String(me?.id ?? ''), error: expected ? `токен относится к @${username || 'неизвестному боту'}, ожидался @${expected}` : 'не задано имя бота' };
    } catch (error) { result = { ok: false, username: '', botId: '', error: clean(error.message, 160) }; }
    if (!result.ok && (verified.ok || verified.error !== result.error)) log.error?.(`client-bot ${botKey}: бот не подтверждён: ${result.error}`);
    verified = { ok: result.ok, at: Date.now(), error: result.error };
    try { await content('/heartbeat', { ok: result.ok, username: result.username, botId: result.botId, error: result.error }); }
    catch (error) { log.warn?.(`client-bot ${botKey}: подтверждение не передано в content: ${clean(error.message, 120)}`); }
    return result.ok;
  }
  async function ensureVerified() {
    if (Date.now() - verified.at >= VERIFY_EVERY || (!verified.ok && Date.now() - verified.at >= 5000)) await verify();
    return verified.ok;
  }
  async function tick() {
    if (running || !contentUrl || !apiKey || !token) return;
    running = true;
    try {
      // Без подтверждённого бота мост не обрабатывает события и ничего не отправляет.
      if (!await ensureVerified()) return;
      const acknowledged = await flushAcks();
      await drainInbox();
      if (acknowledged) await drainOutbox();
    } finally { running = false; }
  }

  /* ---------- получение событий ---------- */
  const getOffset = () => db.prepare('SELECT offset FROM client_bot_checkpoint WHERE bot_key=?').get(botKey)?.offset;
  const saveOffset = (offset) => db.prepare('INSERT INTO client_bot_checkpoint(bot_key,offset) VALUES(?,?) ON CONFLICT(bot_key) DO UPDATE SET offset=excluded.offset').run(botKey, offset);
  /* Одна порция getUpdates: события записываются в очередь и лишь затем подтверждаются смещением. */
  async function pollOnce(timeout = 30) {
    const offset = getOffset();
    const updates = await telegram('getUpdates', { timeout, allowed_updates: ALLOWED_UPDATES, ...(offset === undefined ? {} : { offset }) });
    if (!Array.isArray(updates)) throw new Error('Telegram getUpdates вернул некорректный ответ');
    for (const update of updates) {
      if (!Number.isSafeInteger(update?.update_id)) continue;
      enqueue(update);
      saveOffset(update.update_id + 1);
    }
    return updates.length;
  }
  async function pollLoop() {
    // Webhook удаляется и опрос начинается только для подтверждённого бота: чужой токен не трогает чужой webhook.
    while (!stopped && !await ensureVerified()) await sleep(30000);
    if (stopped) return;
    try { await telegram('deleteWebhook', { drop_pending_updates: false }); }
    catch (error) { log.error?.(`client-bot ${botKey}: не удалось удалить webhook перед опросом: ${clean(error.message, 120)}`); }
    while (!stopped) {
      if (!await ensureVerified()) { await sleep(30000); continue; }
      try { if (await pollOnce() > 0) void tick().catch(() => {}); }
      catch (error) {
        log.error?.(`client-bot ${botKey}: ошибка опроса: ${clean(error.message, 120)}`);
        await sleep(5000);
      }
    }
  }
  /* Webhook: секрет в заголовке обязателен; без него события не принимаются. */
  function checkWebhookSecret(secretHeader) {
    const given = Buffer.from(String(secretHeader || ''));
    const expected = Buffer.from(webhookSecret);
    if (!webhookSecret || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw Object.assign(new Error('Неверный секрет Telegram webhook'), { status: 401 });
    }
  }
  function acceptWebhook(secretHeader, update) {
    checkWebhookSecret(secretHeader);
    const stored = enqueue(update);
    if (stored) void tick().catch(() => {});
    return { ok: true, queued: stored };
  }

  return {
    enqueue, receive, delivery, tick, pollOnce, acceptWebhook, checkWebhookSecret, getOffset, saveOffset, verify,
    ready: () => verified.ok,
    failedInbox: (limit = 20) => db.prepare("SELECT update_id,attempts,error FROM client_bot_inbox WHERE bot_key=? AND state='failed' ORDER BY update_id LIMIT ?")
      .all(botKey, Math.max(1, Math.min(Number(limit) || 20, 100))),
    start() {
      stopped = false;
      timer = setInterval(() => void tick().catch(() => {}), 3000); timer.unref();
      void tick().catch(() => {});
      if (polling) void pollLoop();
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}

module.exports = { createClientBotBridge, ALLOWED_UPDATES };
