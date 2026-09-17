'use strict';

/* Идемпотентность заданий и безопасное состояние входа.
   Готовый ответ переживает перезапуск, повтор того же задания не запускает вторую генерацию,
   а другое содержимое под тем же ключом — конфликт. Токены здесь не хранятся никогда. */

const {DatabaseSync} = require('node:sqlite');
const {conflict, busy} = require('./errors');

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_HOURS = 72;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reply_jobs (
  company_code TEXT NOT NULL,
  job_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reply_text TEXT,
  model TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_expires_at INTEGER,
  PRIMARY KEY (company_code, job_id)
);
CREATE INDEX IF NOT EXISTS reply_jobs_updated ON reply_jobs (updated_at);
CREATE TABLE IF NOT EXISTS login_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  login_id TEXT,
  user_code TEXT,
  verification_url TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS limit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reason TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function createJobStore(database, options = {}) {
  const db = typeof database === 'string' ? new DatabaseSync(database) : database;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const leaseMs = options.leaseMs || DEFAULT_LEASE_MS;
  const retentionMs = (options.retentionHours || DEFAULT_RETENTION_HOURS) * 3600 * 1000;
  const now = options.now || (() => Date.now());

  const selectJob = db.prepare('SELECT * FROM reply_jobs WHERE company_code = ? AND job_id = ?');
  const insertJob = db.prepare(
    `INSERT INTO reply_jobs (company_code, job_id, payload_hash, status, created_at, updated_at, lease_expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
  );
  const takeOverJob = db.prepare(
    `UPDATE reply_jobs SET payload_hash = ?, status = 'pending', reply_text = NULL, model = NULL,
       error_code = NULL, updated_at = ?, lease_expires_at = ?
     WHERE company_code = ? AND job_id = ?`,
  );
  const completeJob = db.prepare(
    `UPDATE reply_jobs SET status = 'completed', reply_text = ?, model = ?, error_code = NULL,
       updated_at = ?, lease_expires_at = NULL
     WHERE company_code = ? AND job_id = ? AND status <> 'completed'`,
  );
  const failJob = db.prepare(
    `UPDATE reply_jobs SET status = 'failed', error_code = ?, updated_at = ?, lease_expires_at = NULL
     WHERE company_code = ? AND job_id = ? AND status <> 'completed'`,
  );
  const pruneJobs = db.prepare("DELETE FROM reply_jobs WHERE status <> 'pending' AND updated_at < ?");
  const releaseStale = db.prepare(
    `UPDATE reply_jobs SET status = 'failed', error_code = 'INTERRUPTED', lease_expires_at = NULL, updated_at = ?
     WHERE status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  );
  const releaseJob = db.prepare("DELETE FROM reply_jobs WHERE company_code = ? AND job_id = ? AND status = 'pending'");
  const selectLimit = db.prepare('SELECT * FROM limit_state WHERE id = 1');
  const upsertLimit = db.prepare(
    `INSERT INTO limit_state (id, reason, until_ms, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, until_ms = excluded.until_ms,
       updated_at = excluded.updated_at`,
  );
  const deleteLimit = db.prepare('DELETE FROM limit_state WHERE id = 1');
  const selectLogin = db.prepare('SELECT * FROM login_state WHERE id = 1');
  const upsertLogin = db.prepare(
    `INSERT INTO login_state (id, status, login_id, user_code, verification_url, expires_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, login_id = excluded.login_id,
       user_code = excluded.user_code, verification_url = excluded.verification_url,
       expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  );

  function row(companyCode, jobId) {
    return selectJob.get(companyCode, jobId) || null;
  }

  /* Возвращает {reuse} для готового ответа либо {lease:true}. Бросает 409 при конфликте. */
  function claim(companyCode, jobId, payloadHash) {
    const timestamp = now();
    const existing = row(companyCode, jobId);
    if (!existing) {
      insertJob.run(companyCode, jobId, payloadHash, timestamp, timestamp, timestamp + leaseMs);
      return {lease: true};
    }
    if (existing.payload_hash !== payloadHash) {
      throw conflict('Задание с таким jobId уже выполнено с другим содержимым');
    }
    if (existing.status === 'completed') {
      return {reuse: {text: existing.reply_text, model: existing.model}};
    }
    if (existing.status === 'pending' && existing.lease_expires_at && existing.lease_expires_at > timestamp) {
      throw busy();
    }
    takeOverJob.run(payloadHash, timestamp, timestamp + leaseMs, companyCode, jobId);
    return {lease: true};
  }

  return {
    db,
    claim,
    get: row,
    complete(companyCode, jobId, text, model) {
      completeJob.run(text, model || null, now(), companyCode, jobId);
    },
    fail(companyCode, jobId, errorCode) {
      failJob.run(String(errorCode || 'FAILED'), now(), companyCode, jobId);
    },
    /* Временный отказ (занято, лимит) не должен выглядеть как попытка: аренда просто снимается,
       и тот же jobId можно прислать снова без конфликта. Готовый ответ не трогается. */
    release(companyCode, jobId) {
      releaseJob.run(companyCode, jobId);
    },
    readLimit() {
      return selectLimit.get() || null;
    },
    saveLimit(limit) {
      upsertLimit.run(String(limit.reason), Math.trunc(limit.until), now());
    },
    clearLimit() {
      deleteLimit.run();
    },
    /* Прерванные при аварии задания становятся повторяемыми, готовые не трогаются. */
    recoverInterrupted() {
      const timestamp = now();
      releaseStale.run(timestamp, timestamp);
    },
    prune() {
      pruneJobs.run(now() - retentionMs);
    },
    readLogin() {
      return selectLogin.get() || null;
    },
    saveLogin(state) {
      upsertLogin.run(
        state.status,
        state.loginId || null,
        state.userCode || null,
        state.verificationUrl || null,
        state.expiresAt || null,
        now(),
      );
    },
    close() {
      db.close();
    },
  };
}

module.exports = {createJobStore, DEFAULT_LEASE_MS, DEFAULT_RETENTION_HOURS};
