'use strict';

const {emailErrorCode} = require('./email-notifications');
const RETRY_DELAYS = [30000, 120000, 600000, 1800000, 3600000];
const LEASE_MS = 120000;
// Failures that concern the sender, the connection or the configuration rather than one
// address: the other recipients of the same claim are not tried after them.
// An unconfirmed acknowledgement is treated the same way: the transport result cannot be trusted
// for this claim, so the other addresses are not sent with it.
const JOB_LEVEL_ERRORS = new Set(['SMTP_NOT_CONFIGURED', 'EMAIL_RECIPIENT_MISSING', 'SMTP_AUTH', 'SMTP_CONNECTION',
  'SMTP_SENDER', 'SMTP_SEND_FAILED', 'EMAIL_DELIVERY_UNCONFIRMED']);
const PRE_SMTP_ERRORS = new Set(['SMTP_NOT_CONFIGURED', 'EMAIL_RECIPIENT_MISSING']);

function createEmailOutbox(db, notifications, {logger = console, now = Date.now, acquireSlot = () => true} = {}) {
  // Only explicit submissions are enqueued. Existing leads are never batch mailed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_email_outbox (
      lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      last_attempt_at TEXT,
      last_error_code TEXT,
      sent_at TEXT,
      repeated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS lead_email_outbox_due_idx ON lead_email_outbox(status,next_attempt_at);
    -- Delivery metadata only (2026-10-27, idempotent): one row per address of a notification.
    -- Existing jobs, their timestamps and business tables are not rewritten.
    CREATE TABLE IF NOT EXISTS lead_email_recipients (
      lead_id INTEGER NOT NULL REFERENCES lead_email_outbox(lead_id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','withdrawn')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error_code TEXT,
      accepted_at TEXT,
      PRIMARY KEY (lead_id, recipient)
    );
  `);
  const get = db.prepare('SELECT * FROM lead_email_outbox WHERE lead_id = ?');
  const insert = db.prepare(`INSERT OR IGNORE INTO lead_email_outbox
    (lead_id,created_at,next_attempt_at,repeated_at) VALUES (?,?,?,?)`);
  const wake = db.prepare("UPDATE lead_email_outbox SET next_attempt_at = ? WHERE lead_id = ? AND status = 'pending'");
  const due = db.prepare(`SELECT * FROM lead_email_outbox
    WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND last_attempt_at <= ?)
    ORDER BY next_attempt_at,lead_id LIMIT 20`);
  const claim = db.prepare(`UPDATE lead_email_outbox SET status = 'sending', attempts = attempts + 1,
    last_attempt_at = ?, last_error_code = NULL WHERE lead_id = ? AND
    ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND last_attempt_at <= ?)) RETURNING attempts`);
  // Only the current lease holder may complete a delivery after a worker restart/takeover.
  const sent = db.prepare("UPDATE lead_email_outbox SET status = 'sent',sent_at = ?,last_error_code = NULL WHERE lead_id = ? AND status = 'sending' AND attempts = ?");
  const failed = db.prepare("UPDATE lead_email_outbox SET status = 'pending',next_attempt_at = ?,last_error_code = ? WHERE lead_id = ? AND status = 'sending' AND attempts = ?");
  // Renewal and release keep the same fencing token (attempts); the lease stays LEASE_MS per step.
  const renew = db.prepare("UPDATE lead_email_outbox SET last_attempt_at = ? WHERE lead_id = ? AND status = 'sending' AND attempts = ?");
  const release = db.prepare("UPDATE lead_email_outbox SET status = 'pending',next_attempt_at = ? WHERE lead_id = ? AND status = 'sending' AND attempts = ?");
  const leadById = db.prepare('SELECT * FROM leads WHERE id = ?');
  const recipientRows = db.prepare('SELECT rowid AS position, * FROM lead_email_recipients WHERE lead_id = ? ORDER BY rowid');
  const addRecipient = db.prepare('INSERT OR IGNORE INTO lead_email_recipients (lead_id,recipient) VALUES (?,?)');
  const dropPending = db.prepare("DELETE FROM lead_email_recipients WHERE lead_id = ? AND recipient = ? AND status = 'pending'");
  const withdraw = db.prepare("UPDATE lead_email_recipients SET status = 'withdrawn' WHERE lead_id = ? AND recipient = ? AND status = 'pending'");
  const recipientPending = db.prepare("SELECT 1 FROM lead_email_recipients WHERE lead_id = ? AND recipient = ? AND status = 'pending'");
  // An acceptance reported by SMTP is a fact: recorded once, never reverted, also when it comes
  // from a superseded worker, so no worker repeats an address that is known to be accepted.
  const accept = db.prepare(`UPDATE lead_email_recipients SET status = 'accepted', accepted_at = ?, attempts = attempts + 1,
    last_attempt_at = ?, last_error_code = NULL WHERE lead_id = ? AND recipient = ? AND status = 'pending'`);
  // A failure is recorded only by the current lease holder and never touches an accepted address.
  const recipientFailed = db.prepare(`UPDATE lead_email_recipients SET attempts = attempts + 1, last_attempt_at = ?, last_error_code = ?
    WHERE lead_id = ? AND recipient = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM lead_email_outbox
      WHERE lead_id = ? AND status = 'sending' AND attempts = ?)`);
  let running = null;
  let stopped = false;
  const iso = (offset = 0) => new Date(now() + offset).toISOString();

  function enqueue(lead, {repeated = false} = {}) {
    const time = new Date(now()).toISOString();
    insert.run(lead.id, time, time, repeated ? time : null);
    // A retried form can wake a failed delivery, but cannot resend a delivered one.
    wake.run(time, lead.id);
    return get.get(lead.id);
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function fail(leadId, token, code, attemptsForDelay) {
    const delay = RETRY_DELAYS[Math.min(Math.max(attemptsForDelay, 1) - 1, RETRY_DELAYS.length - 1)];
    if (failed.run(iso(delay), code, leadId, token).changes) logger.warn(`[crm] lead email pending code=${code}`);
  }

  // Recipient snapshot of one job. Until the first address is accepted the job follows the
  // current company settings (the previous behaviour of a pending single-recipient job, so a
  // corrected address still receives an undelivered lead). From the first acceptance on, the
  // snapshot is frozen: settings changes never add addresses to it, and an address removed
  // from the settings is withdrawn instead of receiving the lead.
  function syncRecipients(leadId, current) {
    return transaction(() => {
      const rows = recipientRows.all(leadId);
      if (!rows.some(row => row.status === 'accepted')) {
        for (const row of rows) if (row.status === 'pending' && !current.includes(row.recipient)) dropPending.run(leadId, row.recipient);
        for (const recipient of current) addRecipient.run(leadId, recipient);
      } else if (current.length) {
        for (const row of rows) if (row.status === 'pending' && !current.includes(row.recipient)) withdraw.run(leadId, row.recipient);
      }
      const after = recipientRows.all(leadId);
      return {accepted: after.filter(row => row.status === 'accepted').length,
        // Addresses tried fewer times go first, so one failing address cannot starve the others.
        pending: after.filter(row => row.status === 'pending').sort((a, b) => a.attempts - b.attempts || a.position - b.position)};
    });
  }

  async function deliverLegacy(row, lead, claimed) {
    try {
      const delivered = await notifications.notifyLead(lead, {
        messageId: `<synapse-lead-${row.lead_id}@synapsebusiness.ru>`,
        repeatedAt: row.repeated_at,
      });
      if (!delivered) throw Object.assign(new Error('SMTP is not configured'), {code: 'SMTP_NOT_CONFIGURED'});
      sent.run(new Date(now()).toISOString(), row.lead_id, claimed.attempts);
    } catch (error) {
      fail(row.lead_id, claimed.attempts, emailErrorCode(error), claimed.attempts);
    }
  }

  async function deliverEach(row, lead, claimed) {
    const token = claimed.attempts;
    const ours = () => Boolean(renew.run(iso(), row.lead_id, token).changes);
    let current;
    try { current = notifications.recipients(lead); } catch (error) { return fail(row.lead_id, token, emailErrorCode(error), token); }
    current = Array.isArray(current) ? current.filter(item => typeof item === 'string' && item) : [];
    const snapshot = syncRecipients(row.lead_id, current);
    if (!snapshot.pending.length) {
      // Every address was accepted, or the rest was withdrawn after an acceptance.
      if (snapshot.accepted) { sent.run(iso(), row.lead_id, token); return; }
      return fail(row.lead_id, token, 'EMAIL_RECIPIENT_MISSING', token);
    }
    if (!current.length) return fail(row.lead_id, token, 'EMAIL_RECIPIENT_MISSING', token);
    let firstError = null, delayAttempts = Infinity, released = false;
    for (const [index, recipient] of snapshot.pending.entries()) {
      if (index > 0) {
        if (stopped) { released = true; break; }
        // Each address is a separate SMTP attempt and needs its own shared-quota slot. A refusal
        // is not an SMTP attempt: the job is released without a delivery error or backoff.
        if (!ours()) return;
        if (!acquireSlot(lead)) { released = true; break; }
      }
      // Another worker may have recorded this address meanwhile; never repeat it.
      if (!recipientPending.get(row.lead_id, recipient.recipient)) continue;
      if (!ours()) return;
      try {
        const delivered = await notifications.notifyLead(lead, {
          messageId: `<synapse-lead-${row.lead_id}@synapsebusiness.ru>`,
          repeatedAt: row.repeated_at,
          recipient: recipient.recipient,
        });
        if (!delivered) throw Object.assign(new Error('SMTP is not configured'), {code: 'SMTP_NOT_CONFIGURED'});
        accept.run(iso(), iso(), row.lead_id, recipient.recipient);
      } catch (error) {
        const code = emailErrorCode(error);
        // A timeout or connection loss is neither a delivery nor a proven non-delivery: the address
        // stays pending and may be retried (SMTP gives no exactly-once guarantee).
        if (!PRE_SMTP_ERRORS.has(code)) recipientFailed.run(iso(), code, row.lead_id, recipient.recipient, row.lead_id, token);
        firstError ||= code;
        delayAttempts = Math.min(delayAttempts, PRE_SMTP_ERRORS.has(code) ? token : recipient.attempts + 1);
        if (JOB_LEVEL_ERRORS.has(code)) break;
      }
    }
    const left = recipientRows.all(row.lead_id);
    // The whole notification is sent only when no address of its snapshot is still pending.
    if (!left.some(item => item.status === 'pending') && left.some(item => item.status === 'accepted')) {
      sent.run(iso(), row.lead_id, token); return;
    }
    if (firstError) return fail(row.lead_id, token, firstError, delayAttempts);
    if (released) { release.run(iso(), row.lead_id, token); return; }
    return fail(row.lead_id, token, 'SMTP_SEND_FAILED', token);
  }

  async function processDue() {
    const time = new Date(now()).toISOString();
    const expired = new Date(now() - LEASE_MS).toISOString();
    for (const row of due.all(time, expired)) {
      if (stopped) break;
      const lead = leadById.get(row.lead_id);
      if (!lead) continue;
      // A shared quota refusal is not an SMTP attempt and must not consume a lease.
      if (!acquireSlot(lead)) break;
      const attemptAt = new Date(now()).toISOString();
      const claimed = claim.get(attemptAt, row.lead_id, time, expired);
      if (!claimed) continue;
      // Notifiers that list recipients get one message per address; older notifiers keep the
      // previous single-message behaviour unchanged.
      if (typeof notifications.recipients === 'function') await deliverEach(row, lead, claimed);
      else await deliverLegacy(row, lead, claimed);
    }
  }
  function drain() {
    if (stopped) return Promise.resolve();
    if (!running) running = processDue().finally(() => { running = null; });
    return running;
  }
  function stop() { stopped = true; return running || Promise.resolve(); }
  return {enqueue, drain, stop};
}

module.exports = {createEmailOutbox, RETRY_DELAYS, LEASE_MS};
