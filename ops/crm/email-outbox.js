'use strict';

const {emailErrorCode} = require('./email-notifications');
const RETRY_DELAYS = [30000, 120000, 600000, 1800000, 3600000];
const LEASE_MS = 120000;

function createEmailOutbox(db, notifications, {logger = console, now = Date.now} = {}) {
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
  const leadById = db.prepare('SELECT * FROM leads WHERE id = ?');
  let running = null;
  let stopped = false;

  function enqueue(lead, {repeated = false} = {}) {
    const time = new Date(now()).toISOString();
    insert.run(lead.id, time, time, repeated ? time : null);
    // A retried form can wake a failed delivery, but cannot resend a delivered one.
    wake.run(time, lead.id);
    return get.get(lead.id);
  }

  async function processDue() {
    const time = new Date(now()).toISOString();
    const expired = new Date(now() - LEASE_MS).toISOString();
    for (const row of due.all(time, expired)) {
      if (stopped) break;
      const attemptAt = new Date(now()).toISOString();
      const claimed = claim.get(attemptAt, row.lead_id, time, expired);
      if (!claimed) continue;
      const lead = leadById.get(row.lead_id);
      if (!lead) continue; // FK deletion removes the queue row with its lead.
      try {
        const delivered = await notifications.notifyLead(lead, {
          messageId: `<synapse-lead-${row.lead_id}@synapsebusiness.ru>`,
          repeatedAt: row.repeated_at,
        });
        if (!delivered) throw Object.assign(new Error('SMTP is not configured'), {code: 'SMTP_NOT_CONFIGURED'});
        sent.run(new Date(now()).toISOString(), row.lead_id, claimed.attempts);
      } catch (error) {
        const code = emailErrorCode(error);
        const delay = RETRY_DELAYS[Math.min(claimed.attempts - 1, RETRY_DELAYS.length - 1)];
        if (failed.run(new Date(now() + delay).toISOString(), code, row.lead_id, claimed.attempts).changes) {
          logger.warn(`[crm] lead email pending code=${code}`);
        }
      }
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
