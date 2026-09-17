'use strict';

/* Долговечное состояние worker: текущее взятое задание и исходящая очередь результатов.

   Результат записывается сюда ДО отправки complete и удаляется только после подтверждения
   сервером (или после окончательного отказа 4xx, который повтор не исправит).
   Неподтверждённые записи retention не трогает никогда. Ключ worker здесь не хранится. */

const {DatabaseSync} = require('node:sqlite');

const DEFAULT_ACKED_RETENTION_MS = 72 * 3600 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS active_job (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  company_code TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  company_code TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_category TEXT,
  acked_at INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS outbox_acked ON outbox (acked_at);
`;

function createOutbox(database, options = {}) {
  const db = typeof database === 'string' ? new DatabaseSync(database) : database;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const now = options.now || (() => Date.now());

  const selectActive = db.prepare('SELECT * FROM active_job WHERE id = 1');
  const upsertActive = db.prepare(
    `INSERT INTO active_job (id, job_id, kind, company_code, payload_json, payload_hash, lease_token, lease_expires_at, boot_id, claimed_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, kind = excluded.kind,
       company_code = excluded.company_code, payload_json = excluded.payload_json,
       payload_hash = excluded.payload_hash, lease_token = excluded.lease_token,
       lease_expires_at = excluded.lease_expires_at, boot_id = excluded.boot_id,
       claimed_at = excluded.claimed_at`,
  );
  const deleteActive = db.prepare('DELETE FROM active_job WHERE id = 1');
  const insertOutbox = db.prepare(
    `INSERT INTO outbox (job_id, kind, company_code, lease_token, payload_hash, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET lease_token = excluded.lease_token,
       payload_hash = excluded.payload_hash, result_json = excluded.result_json,
       created_at = excluded.created_at, attempts = 0, last_attempt_at = NULL,
       last_category = NULL, acked_at = NULL, outcome = NULL`,
  );
  const selectPending = db.prepare('SELECT * FROM outbox WHERE acked_at IS NULL ORDER BY created_at ASC, job_id ASC');
  const countPending = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE acked_at IS NULL');
  const recordAttempt = db.prepare(
    'UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ?, last_category = ? WHERE job_id = ?',
  );
  const markAcked = db.prepare('UPDATE outbox SET acked_at = ?, outcome = ? WHERE job_id = ? AND acked_at IS NULL');
  const pruneAcked = db.prepare('DELETE FROM outbox WHERE acked_at IS NOT NULL AND acked_at < ?');
  const selectOne = db.prepare('SELECT * FROM outbox WHERE job_id = ?');

  function rowToActive(row) {
    if (!row) return null;
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = null;
    }
    return {
      jobId: row.job_id,
      kind: row.kind,
      companyCode: row.company_code,
      payload,
      payloadHash: row.payload_hash,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      bootId: row.boot_id,
      claimedAt: row.claimed_at,
    };
  }

  function rowToOutbox(row) {
    let result;
    try {
      result = JSON.parse(row.result_json);
    } catch {
      result = null;
    }
    return {
      jobId: row.job_id,
      kind: row.kind,
      companyCode: row.company_code,
      leaseToken: row.lease_token,
      payloadHash: row.payload_hash,
      result,
      createdAt: row.created_at,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,
      lastCategory: row.last_category,
      ackedAt: row.acked_at,
      outcome: row.outcome,
    };
  }

  return {
    db,
    /* Задание записывается сразу после claim: при обрыве питания оно не потеряется. */
    saveActiveJob(job) {
      upsertActive.run(
        job.jobId,
        job.kind,
        job.companyCode,
        JSON.stringify(job.payload ?? {}),
        job.payloadHash,
        job.leaseToken,
        job.leaseExpiresAt,
        job.bootId,
        Math.trunc(job.claimedAt ?? now()),
      );
    },
    readActiveJob() {
      return rowToActive(selectActive.get() || null);
    },
    clearActiveJob() {
      deleteActive.run();
    },
    /* Результат и снятие активного задания — одна транзакция: либо оба, либо ничего. */
    enqueue(entry) {
      db.exec('BEGIN IMMEDIATE');
      try {
        insertOutbox.run(
          entry.jobId,
          entry.kind,
          entry.companyCode,
          entry.leaseToken,
          entry.payloadHash,
          JSON.stringify(entry.result),
          now(),
        );
        deleteActive.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    pending() {
      return selectPending.all().map(rowToOutbox);
    },
    pendingCount() {
      return Number(countPending.get().n);
    },
    get(jobId) {
      const row = selectOne.get(jobId);
      return row ? rowToOutbox(row) : null;
    },
    recordAttempt(jobId, category) {
      recordAttempt.run(now(), String(category || 'unknown').slice(0, 32), jobId);
    },
    /* outcome: accepted — сервер принял; rejected — сервер окончательно отказал (409/403/4xx). */
    markAcked(jobId, outcome) {
      markAcked.run(now(), outcome === 'rejected' ? 'rejected' : 'accepted', jobId);
    },
    /* Удаляются только подтверждённые записи старше retention. Неподтверждённые остаются всегда. */
    pruneAcked(retentionMs = DEFAULT_ACKED_RETENTION_MS) {
      pruneAcked.run(now() - retentionMs);
    },
    close() {
      db.close();
    },
  };
}

module.exports = {createOutbox, DEFAULT_ACKED_RETENTION_MS};
