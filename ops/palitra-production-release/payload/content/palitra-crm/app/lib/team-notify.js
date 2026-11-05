'use strict';
/*
 * Основной канал уведомления команды Palitra о новом обращении — личное сообщение подтверждённому менеджеру
 * через СУЩЕСТВУЮЩИЙ бот хоста. Резервная почта (email-fallback) срабатывает, только если здесь нет квитанции.
 *
 * Покрывает обращения, у которых нет своего основного уведомления: ручные (Instagram / Telegram / звонок) и
 * входящие Instagram. Заявки сайта уведомляются прежней очередью site_order_outbox (destination=manager),
 * входящие сообщения Telegram — telegram-ingest (pendingNotifications/markNotified); их здесь не дублируем.
 *
 * Модуль не читает токены и окружение, не открывает сокеты и не запускает таймеров: отправку выполняет только
 * переданный хостом адаптер sendTelegram, вызываемый из единственного планировщика хоста (palitra.scheduler.tick).
 * Без enabled:true, подтверждённого получателя и адаптера задания копятся в очереди и ничего не отправляется.
 *
 * Статусы: pending → sending → sent (квитанция Telegram: message_id и тот же chat_id)
 *          | pending (известный временный отказ, до 3 попыток) | error (известный отказ, не отправлено)
 *          | uncertain (обрыв/таймаут/неполный ответ — могло дойти; автоматически НЕ повторяется).
 */
const { randomUUID } = require('node:crypto');

const COMPANY = 'palitra-love';
const LEASE_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_MS = [30_000, 120_000];
const SOURCES = { instagram: 'Instagram', telegram: 'Telegram', call: 'Звонок' };
// Только личный чат менеджера: положительный id пользователя. Группы/супергруппы/каналы (отрицательный id) — нет.
const PRIVATE_CHAT_ID = /^[1-9]\d{0,19}$/;
const BOT_ID = /^[1-9]\d{0,19}$/;
const errorCode = (value) => (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(value) ? value : 'TELEGRAM_SEND_FAILED');

/**
 * recipient — подтверждённая хостом привязка менеджера Palitra к существующему боту: { chatId, version }.
 *   chatId — id личного чата менеджера с ботом (= его Telegram user id), version — версия этой привязки в хосте.
 *   Модуль не может сам доказать, что человек — менеджер Palitra: это решение хоста (его таблица привязок).
 *   Модуль строго проверяет форму (личный чат) и каждую квитанцию; задание запоминает chat_id и версию привязки.
 * botId — id существующего бота, через который хост отправляет; квитанция чужого бота не засчитывается.
 */
function createTeamNotifier({ db, now = Date.now, enabled = false, recipient = null, botId = null, sendTelegram = null, inquiryExists } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Требуется SQLite');
  if (typeof inquiryExists !== 'function') throw new TypeError('Требуется проверка обращения');
  if (sendTelegram !== null && typeof sendTelegram !== 'function') throw new TypeError('Некорректный адаптер Telegram');
  const validTarget = (value) => value && typeof value === 'object' && PRIVATE_CHAT_ID.test(String(value.chatId ?? ''))
    && Number.isSafeInteger(value.version) && value.version >= 1;
  // recipient — объект (фиксированная привязка) или функция, которая при каждом захвате читает действующую
  // подтверждённую привязку хоста (например, site_order_recipients с verified_at). null — привязки нет.
  if (recipient !== null && typeof recipient !== 'function' && !validTarget(recipient)) {
    throw new TypeError('Получатель: { chatId, version } — личный чат подтверждённого менеджера из настроек хоста (не группа)');
  }
  if (botId !== null && !BOT_ID.test(String(botId))) throw new TypeError('botId: id существующего бота хоста');
  const currentTarget = () => {
    let value = recipient;
    if (typeof recipient === 'function') { try { value = recipient(); } catch { value = null; } }
    return validTarget(value) ? Object.freeze({ chatId: String(value.chatId), version: value.version }) : null;
  };
  const expectedBot = botId === null ? null : String(botId);
  db.exec(`CREATE TABLE IF NOT EXISTS palitra_team_notify_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      inquiry_id INTEGER NOT NULL, event TEXT NOT NULL DEFAULT 'new_inquiry' CHECK(event='new_inquiry'),
      destination TEXT NOT NULL DEFAULT 'manager' CHECK(destination='manager'),
      source TEXT NOT NULL CHECK(source IN ('instagram','telegram','call')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','error')),
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
      claimed_at TEXT, claim_token TEXT, chat_id TEXT, recipient_version INTEGER, message_id TEXT,
      finished_at TEXT, last_error_code TEXT,
      UNIQUE(company_code, inquiry_id, event, destination)
    );
    CREATE INDEX IF NOT EXISTS palitra_team_notify_due ON palitra_team_notify_outbox(company_code, status, next_attempt_at);`);
  const stamp = (ms = now()) => new Date(ms).toISOString();
  let depth = 0;
  const atomic = (fn) => {
    const name = `palitra_team_notify_${++depth}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
    finally { depth--; }
  };
  const availability = () => (!enabled ? 'disabled' : !currentTarget() ? 'no_recipient' : !expectedBot ? 'no_bot'
    : typeof sendTelegram !== 'function' ? 'transport_unavailable' : 'ready');

  /** Вызывать в той же транзакции, что и сохранение нового обращения. Повтор того же обращения — одно задание. */
  function enqueue(inquiryId, source) {
    if (!Number.isSafeInteger(inquiryId) || inquiryId < 1 || inquiryExists(inquiryId) !== true) throw Object.assign(new Error('Обращение не найдено'), { status: 404 });
    if (!Object.hasOwn(SOURCES, source)) throw Object.assign(new Error('Неизвестный источник уведомления'), { status: 400 });
    db.prepare(`INSERT OR IGNORE INTO palitra_team_notify_outbox(company_code,inquiry_id,source,status,created_at,next_attempt_at)
      VALUES(?,?,?,'pending',?,?)`).run(COMPANY, inquiryId, source, stamp(), stamp());
    return status(inquiryId);
  }
  const byInquiry = db.prepare("SELECT * FROM palitra_team_notify_outbox WHERE company_code=? AND inquiry_id=? AND event='new_inquiry' AND destination='manager'");
  function status(inquiryId) {
    const row = byInquiry.get(COMPANY, inquiryId);
    if (!row) return { status: 'not_registered', availability: availability() };
    return { status: row.status, attempts: row.attempts, availability: availability(), messageId: row.message_id,
      finishedAt: row.finished_at, errorCode: row.last_error_code };
  }
  /** Для резервной почты: задания основного канала по обращению (тот же формат, что у очереди сайта). */
  function jobs(inquiryId) {
    const row = byInquiry.get(COMPANY, inquiryId);
    return row ? [{ status: row.status, created_at: row.created_at, claimed_at: row.claimed_at }] : [];
  }
  const expire = () => db.prepare(`UPDATE palitra_team_notify_outbox SET status='uncertain',last_error_code='TELEGRAM_LEASE_EXPIRED',finished_at=?
    WHERE company_code=? AND status='sending' AND claimed_at<=?`).run(stamp(), COMPANY, stamp(now() - LEASE_MS));

  function claim() {
    return atomic(() => {
      expire();
      if (availability() !== 'ready') return null;
      const row = db.prepare(`SELECT * FROM palitra_team_notify_outbox WHERE company_code=? AND status='pending' AND attempts<? AND next_attempt_at<=?
        ORDER BY id LIMIT 1`).get(COMPANY, MAX_ATTEMPTS, stamp());
      if (!row) return null;
      if (inquiryExists(row.inquiry_id) !== true) {
        db.prepare("UPDATE palitra_team_notify_outbox SET status='error',last_error_code='INQUIRY_MISSING',finished_at=? WHERE id=?").run(stamp(), row.id);
        return { skip: true };
      }
      // Получатель (действующая подтверждённая привязка и её версия) фиксируется в задании при захвате:
      // квитанция сверяется именно с ним; смена привязки позже не перенаправляет начатую отправку.
      const target = currentTarget();
      if (!target) return null;
      return db.prepare(`UPDATE palitra_team_notify_outbox SET status='sending',attempts=attempts+1,claimed_at=?,claim_token=?,chat_id=?,recipient_version=?,last_error_code=NULL
        WHERE id=? AND status='pending' RETURNING *`).get(stamp(), randomUUID(), target.chatId, target.version, row.id) || { skip: true };
    });
  }
  // В тексте нет контактов клиента: номер и источник; подробности сотрудник видит в приложении после входа.
  const message = (row) => ({ chatId: row.chat_id, recipientVersion: row.recipient_version,
    text: `Новое обращение Palitra №${row.inquiry_id} · ${SOURCES[row.source]}. Откройте приложение Palitra, чтобы ответить клиенту.`,
    idempotencyKey: `palitra:inquiry:${row.inquiry_id}:new_inquiry:telegram:manager` });

  async function deliver(row) {
    const abort = new AbortController();
    let timer, result;
    try {
      const timeout = new Promise((resolve) => { timer = setTimeout(() => { abort.abort(); resolve({ uncertain: true, code: 'TELEGRAM_TIMEOUT' }); }, SEND_TIMEOUT_MS); });
      result = await Promise.race([Promise.resolve().then(() => sendTelegram({ ...message(row), signal: abort.signal })), timeout]);
    } catch { result = { uncertain: true, code: 'TELEGRAM_DELIVERY_UNKNOWN' }; }
    finally { clearTimeout(timer); }
    // Квитанция: успех без неопределённости, message_id и тот же подтверждённый получатель.
    // Проверяется и здесь, независимо от адаптера: ожидаемый бот, личный чат, тот же получатель, что зафиксирован при захвате.
    const receipt = result?.ok === true && result.uncertain !== true && Number.isSafeInteger(result.messageId) && result.messageId > 0
      && String(result.chatId) === row.chat_id && result.chatType === 'private' && String(result.botId) === expectedBot;
    const permanent = !receipt && result?.ok === false && result.permanent === true && result.uncertain === false;
    const retryable = !receipt && !permanent && result?.ok === false && result.retryable === true && result.uncertain === false;
    const next = receipt ? 'sent' : permanent ? 'error' : retryable ? (row.attempts < MAX_ATTEMPTS ? 'pending' : 'error') : 'uncertain';
    const code = receipt ? null : next === 'uncertain' && result?.ok === true ? 'TELEGRAM_RECEIPT_UNCONFIRMED' : errorCode(result?.code);
    db.prepare(`UPDATE palitra_team_notify_outbox SET status=?,message_id=?,last_error_code=?,next_attempt_at=?,finished_at=?
      WHERE id=? AND status='sending' AND claim_token=?`)
      .run(next, receipt ? String(result.messageId) : null, code,
        next === 'pending' ? stamp(now() + (RETRY_MS[row.attempts - 1] || RETRY_MS[RETRY_MS.length - 1])) : row.next_attempt_at,
        next === 'pending' ? null : stamp(), row.id, row.claim_token);
    return status(row.inquiry_id);
  }
  let running = null;
  async function run() {
    const done = [];
    for (let i = 0; i < 20; i++) {
      const row = claim();
      if (!row) break;
      if (row.skip) continue;
      done.push(await deliver(row));
    }
    return { processed: done.length, statuses: done };
  }
  /** Один проход из планировщика хоста. Параллельный вызов в том же процессе ждёт текущий проход. */
  function drain() { if (!running) running = run().finally(() => { running = null; }); return running; }
  return { enqueue, status, jobs, drain, availability };
}

module.exports = { createTeamNotifier, LEASE_MS, SEND_TIMEOUT_MS, MAX_ATTEMPTS };
