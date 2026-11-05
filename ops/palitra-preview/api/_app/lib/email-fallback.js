'use strict';

const { randomUUID } = require('node:crypto');
const { validEmailAddress } = require('./email-address');

const SITE = 'palitra';
const COMPANY = 'palitra-love';
const GRACE_MS = 60_000;
const LEASE_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_MS = [30_000, 120_000];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const errorCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(value)
  ? value : 'EMAIL_SEND_FAILED';

/** Резервное письмо собственнику о новом обращении, если основной канал (Telegram команды) не подтвердил доставку.
 * Никогда не читает секреты, не открывает сокеты и не меняет таблицы других модулей.
 * sendEmail — явно переданный адаптер; письмо уходит только при включённом runtime, сохранённом
 * разрешении собственника и указанном адресе. Ответ адаптера должен описывать известный успех или
 * известный отказ; исключение, таймаут или неполный ответ — неизвестная доставка, повтора нет.
 *
 * inquiryExists(id) → boolean: обращение принадлежит Palitra.
 * primaryJobs(id) → [{status:'pending'|'sending'|'sent'|'uncertain'|'error', created_at, claimed_at}]:
 *   задания основного канала по этому обращению (для заявки сайта — очередь site_order_outbox менеджеру).
 */
function createInquiryEmailFallback({ db, now = Date.now, sendEmail = null, enabled = false, inquiryExists, primaryJobs = () => [] } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Требуется SQLite database');
  if (typeof now !== 'function') throw new TypeError('Требуется функция времени');
  if (sendEmail !== null && typeof sendEmail !== 'function') throw new TypeError('Некорректный почтовый адаптер');
  if (typeof inquiryExists !== 'function' || typeof primaryJobs !== 'function') throw new TypeError('Требуются проверки обращения и основного канала');
  const runtimeEnabled = enabled === true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS palitra_email_fallback_settings (
      site TEXT PRIMARY KEY CHECK(site='palitra'), company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      email TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS palitra_email_fallback_watch (
      company_code TEXT NOT NULL CHECK(company_code='palitra-love'), inquiry_id INTEGER NOT NULL,
      registered_at TEXT NOT NULL, PRIMARY KEY(company_code,inquiry_id)
    );
    CREATE TABLE IF NOT EXISTS palitra_email_fallback_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
      inquiry_id INTEGER NOT NULL,
      event TEXT NOT NULL DEFAULT 'new_inquiry' CHECK(event='new_inquiry'),
      channel TEXT NOT NULL DEFAULT 'email' CHECK(channel='email'),
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','uncertain','error','suppressed')),
      reason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
      claimed_at TEXT, claim_token TEXT, finished_at TEXT, message_id TEXT, last_error_code TEXT,
      UNIQUE(company_code,inquiry_id,event,channel)
    );
    CREATE INDEX IF NOT EXISTS palitra_email_fallback_due ON palitra_email_fallback_outbox(company_code,status,next_attempt_at);
  `);
  // Счётчик ручных восстановлений после подтверждённого отказа (добавляется и в уже созданную таблицу).
  if (!db.prepare('PRAGMA table_info(palitra_email_fallback_outbox)').all().some((c) => c.name === 'recoveries')) {
    db.exec('ALTER TABLE palitra_email_fallback_outbox ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0');
  }
  const MAX_RECOVERIES = 3;

  const stamp = () => new Date(now()).toISOString();
  let savepoint = 0;
  const atomic = (fn) => {
    const name = `palitra_email_fallback_${++savepoint}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
  };
  const owner = (actor) => {
    if (!actor || actor.role !== 'owner' || actor.companyCode !== COMPANY) fail(403, 'Настройка резервной почты доступна только собственнику Palitra');
  };
  const check = (id) => {
    if (!Number.isSafeInteger(id) || id < 1 || inquiryExists(id) !== true) fail(404, 'Обращение не найдено');
  };
  const config = () => db.prepare('SELECT * FROM palitra_email_fallback_settings WHERE site=? AND company_code=?')
    .get(SITE, COMPANY) || { email: '', enabled: 0, updated_at: null };
  const availability = (value = config()) => !value.email ? 'unconfigured'
    : !runtimeEnabled || !value.enabled ? 'disabled'
      : typeof sendEmail !== 'function' ? 'transport_unavailable' : 'ready';
  function settings(actor) {
    owner(actor);
    const value = config();
    const sent = db.prepare("SELECT max(finished_at) at FROM palitra_email_fallback_outbox WHERE company_code=? AND status='sent'").get(COMPANY).at;
    const counts = db.prepare(`SELECT
        sum(status='error' AND recoveries<${MAX_RECOVERIES}) failed, sum(status='uncertain') unknown
      FROM palitra_email_fallback_outbox WHERE company_code=?`).get(COMPANY);
    return { email: value.email, enabled: Boolean(value.enabled), configured: Boolean(value.email),
      runtimeEnabled, deliveryEnabled: availability(value) === 'ready',
      availability: availability(value), updatedAt: value.updated_at, lastSentAt: sent || null,
      // Не отправлено по подтверждённой причине (неверный адрес, отказ сервера) — можно отправить заново явным действием.
      failedKnown: Number(counts.failed || 0),
      // Результат неизвестен (обрыв, таймаут): повтор никогда не выполняется автоматически, проверить почту вручную.
      unknownResult: Number(counts.unknown || 0) };
  }
  /**
   * Настройки собственника. retryFailed:true — явное восстановление: письма со статусом error (сервер или адаптер
   * подтвердил, что письмо НЕ отправлено) снова ставятся в очередь на ТЕКУЩИЙ адрес. uncertain не трогается никогда.
   */
  function configure(body, actor) {
    owner(actor);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['email', 'enabled', 'retryFailed'].includes(key))) fail(400, 'Некорректные настройки');
    const previous = config();
    const email = body.email === undefined ? previous.email : body.email;
    if (typeof email !== 'string') fail(400, 'Некорректный адрес почты');
    const address = email.trim();
    if (address && !validEmailAddress(address)) fail(400, 'Некорректный адрес почты');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'Некорректный переключатель почты');
    if (body.retryFailed !== undefined && body.retryFailed !== true) fail(400, 'Некорректное действие');
    return atomic(() => {
      db.prepare(`INSERT INTO palitra_email_fallback_settings(site,company_code,email,enabled,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(site) DO UPDATE SET email=excluded.email,enabled=excluded.enabled,updated_at=excluded.updated_at`)
        .run(SITE, COMPANY, address, Number(body.enabled === undefined ? previous.enabled : body.enabled), stamp());
      let recovered = 0;
      if (body.retryFailed === true) {
        if (availability() !== 'ready') fail(409, 'Сначала укажите адрес и включите отправку — сейчас письма не уходят');
        recovered = Number(db.prepare(`UPDATE palitra_email_fallback_outbox
          SET status='pending',attempts=0,recoveries=recoveries+1,next_attempt_at=?,finished_at=NULL,claimed_at=NULL,claim_token=NULL,last_error_code=NULL
          WHERE company_code=? AND status='error' AND recoveries<?`).run(stamp(), COMPANY, MAX_RECOVERIES).changes);
      }
      return { ...settings(actor), recovered };
    });
  }

  /** Вызывать в той же транзакции, что и сохранение нового обращения: сбой регистрации откатывает обращение. */
  function register(inquiryId) {
    check(inquiryId);
    db.prepare('INSERT OR IGNORE INTO palitra_email_fallback_watch(company_code,inquiry_id,registered_at) VALUES(?,?,?)')
      .run(COMPANY, inquiryId, stamp());
    return status(inquiryId);
  }
  const watchById = db.prepare('SELECT * FROM palitra_email_fallback_watch WHERE company_code=? AND inquiry_id=?');
  const emailById = db.prepare('SELECT * FROM palitra_email_fallback_outbox WHERE company_code=? AND inquiry_id=?');
  function primaryState(inquiryId, registeredAt) {
    let jobs;
    try { jobs = primaryJobs(inquiryId); } catch { jobs = []; }
    jobs = Array.isArray(jobs) ? jobs : [];
    if (jobs.some((job) => job.status === 'sent')) return { sent: true, reason: 'primary_sent' };
    const time = now();
    const elapsed = (value, fallback) => time - (Number.isFinite(Date.parse(value)) ? Date.parse(value) : Date.parse(fallback));
    // Начатая отправка ещё может пройти: отказ не предполагается до конца полного срока аренды.
    if (jobs.some((job) => job.status === 'sending' && elapsed(job.claimed_at, job.created_at || registeredAt) < LEASE_MS)) {
      return { sent: false, reason: 'primary_sending', due: false };
    }
    const latest = jobs[0];
    if (!latest) return { sent: false, reason: 'primary_missing', due: elapsed(registeredAt, registeredAt) >= GRACE_MS };
    if (latest.status === 'error' || latest.status === 'uncertain') return { sent: false, reason: `primary_${latest.status}`, due: true };
    if (latest.status === 'sending') return { sent: false, reason: 'primary_lease_expired', due: true };
    return { sent: false, reason: 'primary_pending', due: elapsed(latest.created_at, registeredAt) >= GRACE_MS };
  }
  const expireLeases = () => db.prepare(`UPDATE palitra_email_fallback_outbox
    SET status='uncertain',last_error_code='EMAIL_LEASE_EXPIRED',finished_at=?
    WHERE company_code=? AND status='sending' AND claimed_at<=?`).run(stamp(), COMPANY, new Date(now() - LEASE_MS).toISOString());
  function scan() {
    return atomic(() => {
      expireLeases();
      const watches = db.prepare('SELECT * FROM palitra_email_fallback_watch WHERE company_code=? ORDER BY inquiry_id').all(COMPANY)
        .filter((w) => inquiryExists(w.inquiry_id) === true);
      for (const watch of watches) {
        const primary = primaryState(watch.inquiry_id, watch.registered_at);
        if (primary.sent) {
          db.prepare(`UPDATE palitra_email_fallback_outbox SET status='suppressed',reason='primary_sent',finished_at=?
            WHERE company_code=? AND inquiry_id=? AND status IN ('pending','error')`).run(stamp(), COMPANY, watch.inquiry_id);
        } else if (primary.due) {
          db.prepare(`INSERT OR IGNORE INTO palitra_email_fallback_outbox
            (company_code,inquiry_id,event,channel,status,reason,created_at,next_attempt_at)
            VALUES(?,?,'new_inquiry','email','pending',?,?,?)`).run(COMPANY, watch.inquiry_id, primary.reason, stamp(), stamp());
        }
      }
      return { registered: watches.length };
    });
  }
  function status(inquiryId) {
    check(inquiryId);
    const watch = watchById.get(COMPANY, inquiryId);
    const row = emailById.get(COMPANY, inquiryId);
    const primary = watch ? primaryState(inquiryId, watch.registered_at) : null;
    return { inquiryId, registered: Boolean(watch), status: row?.status || (!watch ? 'not_registered'
      : primary.sent ? 'suppressed' : 'waiting_primary'),
      reason: row?.reason || primary?.reason || null, attempts: row?.attempts || 0,
      availability: availability(), nextAttemptAt: row?.next_attempt_at || null,
      finishedAt: row?.finished_at || null, messageId: row?.message_id || null, errorCode: row?.last_error_code || null };
  }

  function claimNext() {
    return atomic(() => {
      expireLeases();
      const current = config();
      if (availability(current) !== 'ready') return null;
      const candidates = db.prepare(`SELECT q.*,w.registered_at FROM palitra_email_fallback_outbox q
        JOIN palitra_email_fallback_watch w ON w.company_code=q.company_code AND w.inquiry_id=q.inquiry_id
        WHERE q.company_code=? AND q.status='pending' AND q.attempts<? AND q.next_attempt_at<=? ORDER BY q.id`)
        .all(COMPANY, MAX_ATTEMPTS, stamp());
      for (const row of candidates) {
        if (inquiryExists(row.inquiry_id) !== true) continue;
        const primary = primaryState(row.inquiry_id, row.registered_at);
        if (primary.sent) {
          db.prepare("UPDATE palitra_email_fallback_outbox SET status='suppressed',reason='primary_sent',finished_at=? WHERE id=? AND status='pending'").run(stamp(), row.id);
          continue;
        }
        if (!primary.due) continue;
        const token = randomUUID();
        const claimed = db.prepare(`UPDATE palitra_email_fallback_outbox
          SET status='sending',attempts=attempts+1,claimed_at=?,claim_token=?,last_error_code=NULL
          WHERE id=? AND status='pending' AND attempts<? AND next_attempt_at<=? RETURNING *`)
          .get(stamp(), token, row.id, MAX_ATTEMPTS, stamp());
        if (claimed) return { row: claimed, email: current.email };
      }
      return null;
    });
  }
  // В письме нет контактов, имени и адреса клиента: только номер обращения и просьба проверить приложение.
  function message(claim) {
    const id = claim.row.inquiry_id;
    return { to: claim.email, subject: `Резервное уведомление Palitra: обращение №${id}`,
      text: `Резервное уведомление.\nОбращение №${id} сохранено в приложении Palitra.\n`
        + 'Telegram команды не подтвердил своевременную доставку уведомления. Проверьте обращение в приложении.\n'
        + 'Это уведомление о том же обращении, а не новый заказ.',
      site: SITE, companyCode: COMPANY, inquiryId: id, event: 'new_inquiry', channel: 'email',
      idempotencyKey: `${SITE}:inquiry:${id}:new_inquiry:email` };
  }
  async function deliver(claim) {
    const abort = new AbortController();
    let timer;
    let result;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { abort.abort(); resolve({ uncertain: true, code: 'EMAIL_TIMEOUT' }); }, SEND_TIMEOUT_MS);
      });
      result = await Promise.race([Promise.resolve().then(() => sendEmail({ ...message(claim), signal: abort.signal })), timeout]);
    } catch {
      result = { uncertain: true, code: 'EMAIL_DELIVERY_UNKNOWN' };
    } finally { clearTimeout(timer); }
    const receipt = result?.ok === true && !result?.uncertain && typeof result.messageId === 'string'
      && result.messageId.trim().length > 0 && result.messageId.length <= 256 && !/[\x00-\x1f\x7f]/.test(result.messageId);
    // Явная неопределённость сильнее противоречивого «можно повторить».
    const permanent = !receipt && result?.ok !== true && result?.permanent === true && result?.uncertain === false;
    const retryable = !receipt && !permanent && result?.ok !== true && result?.retryable === true && !result?.uncertain;
    const nextStatus = receipt ? 'sent' : permanent ? 'error' : retryable ? (claim.row.attempts < MAX_ATTEMPTS ? 'pending' : 'error') : 'uncertain';
    const nextAt = new Date(now() + (RETRY_MS[claim.row.attempts - 1] || RETRY_MS[RETRY_MS.length - 1])).toISOString();
    db.prepare(`UPDATE palitra_email_fallback_outbox SET status=?,message_id=?,last_error_code=?,next_attempt_at=?,finished_at=?
      WHERE id=? AND status='sending' AND claim_token=? AND attempts=?`)
      .run(nextStatus, receipt ? result.messageId : null,
        receipt ? null : retryable || permanent ? errorCode(result.code) : errorCode(result?.code || 'EMAIL_DELIVERY_UNKNOWN'),
        nextStatus === 'pending' ? nextAt : claim.row.next_attempt_at,
        nextStatus === 'pending' ? null : stamp(), claim.row.id, claim.row.claim_token, claim.row.attempts);
    return status(claim.row.inquiry_id);
  }
  let running = null;
  async function processDue() {
    scan();
    const delivered = [];
    // Ограниченная пачка: хост остаётся отзывчивым при большом числе обращений.
    for (let count = 0; count < 20; count++) {
      const claim = claimNext();
      if (!claim) break;
      delivered.push(await deliver(claim));
    }
    return { processed: delivered.length, statuses: delivered };
  }
  function drain() {
    if (!running) running = processDue().finally(() => { running = null; });
    return running;
  }
  return { configure, settings, register, scan, drain, status, availability: () => availability() };
}

module.exports = { createInquiryEmailFallback, GRACE_MS, LEASE_MS, SEND_TIMEOUT_MS, MAX_ATTEMPTS };
