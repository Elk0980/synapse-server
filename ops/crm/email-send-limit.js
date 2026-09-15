'use strict';

const DAY = 86400000;
function createEmailSendLimit(db, {now = Date.now, dailyCap = 100, intervalMs = 2000} = {}) {
  dailyCap = Number(dailyCap);
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1 || dailyCap > 2000) throw Error('CRM_MAIL_DAILY_CAP must be between 1 and 2000');
  db.exec('CREATE TABLE IF NOT EXISTS email_send_slots (id INTEGER PRIMARY KEY, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS email_send_slots_at_idx ON email_send_slots(at)');
  function acquire() {
    const time = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM email_send_slots WHERE at <= ?').run(time - DAY);
      const row = db.prepare('SELECT COUNT(*) count, MIN(at) first, MAX(at) last FROM email_send_slots').get();
      const retryAt = Math.max(row.count >= dailyCap ? row.first + DAY : 0, row.last === null ? 0 : row.last + intervalMs);
      if (retryAt > time) { db.exec('COMMIT'); return {ok: false, retryAt}; }
      db.prepare('INSERT INTO email_send_slots(at) VALUES(?)').run(time);
      db.exec('COMMIT');
      return {ok: true};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {acquire, dailyCap, intervalMs};
}
module.exports = {createEmailSendLimit, DAY};
