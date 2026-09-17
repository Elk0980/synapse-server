'use strict';

/* Публичное состояние рантайма для heartbeat и безопасный status.json для наблюдения.

   Оба вида строятся по белым спискам полей: сюда не попадают loginUrl, userCode,
   тексты ошибок, пути, переписка и ключ. Всё, что не прошло проверку типа, заменяется null. */

const fs = require('node:fs');
const path = require('node:path');

const STATUS_SCHEMA = 1;
const RUNTIME_STATES = new Set(['connected', 'login_required', 'connecting', 'unavailable']);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;
const MAX_INT = 2 ** 31 - 1;

const bool = (value) => value === true;
/* null/undefined/'' — отсутствие значения, а не ноль: Number(null) даёт 0. */
const intOrNull = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(MAX_INT, Math.trunc(number));
};
const isoOrNull = (value) => {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const codeOrNull = (value) => (typeof value === 'string' && CODE_PATTERN.test(value) ? value : null);
const reasonOrNull = (value) => (typeof value === 'string' && REASON_PATTERN.test(value) ? value : null);

/* Ограниченные публичные поля рантайма: ровно те, что перечислены в контракте heartbeat.
   Кодов входа здесь нет и быть не может. */
function publicRuntimeStatus(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const safety = source.safety && typeof source.safety === 'object' ? source.safety : {};
  return {
    state: RUNTIME_STATES.has(source.state) ? source.state : 'unavailable',
    authenticated: bool(source.authenticated),
    connected: bool(source.connected),
    available: bool(source.available),
    limited: bool(source.limited),
    retryAfter: intOrNull(source.retryAfter),
    provider: 'codex',
    model: typeof source.model === 'string' && MODEL_PATTERN.test(source.model) ? source.model : null,
    safety: {
      toolIsolationVerified: bool(safety.toolIsolationVerified),
      reason: reasonOrNull(safety.reason),
    },
    errorCode: codeOrNull(source.errorCode),
  };
}

/* Метрики сервера из ответа heartbeat: только согласованные поля и только безопасные типы. */
function sanitizeServerStats(stats) {
  const source = stats && typeof stats === 'object' ? stats : {};
  return {
    lastSeen: isoOrNull(source.lastSeen),
    offline: bool(source.offline),
    pendingAi: intOrNull(source.pendingAi),
    oldestPendingAgeSeconds: intOrNull(source.oldestPendingAgeSeconds),
    humanMessagesWhileOffline24h: intOrNull(source.humanMessagesWhileOffline24h),
    aiRequestsWhileOffline24h: intOrNull(source.aiRequestsWhileOffline24h),
  };
}

/* Собирает документ status.json из частей, каждая — через свой белый список. */
function buildStatusDocument(input) {
  const worker = input.worker || {};
  const counters = worker.counters || {};
  const server = input.server || {};
  const active = worker.activeJob || null;
  const lastTransport = worker.lastTransport || null;
  return {
    schema: STATUS_SCHEMA,
    updatedAt: isoOrNull(input.updatedAt) || new Date().toISOString(),
    bootId: typeof input.bootId === 'string' ? input.bootId.slice(0, 64) : null,
    startedAt: isoOrNull(input.startedAt),
    worker: {
      version: typeof worker.version === 'string' ? worker.version.slice(0, 32) : null,
      running: bool(worker.running),
      activeJob: active
        ? {kind: active.kind === 'login' ? 'login' : 'reply', claimedAt: isoOrNull(active.claimedAt), leaseLost: bool(active.leaseLost)}
        : null,
      outboxPending: intOrNull(worker.outboxPending) ?? 0,
      counters: {
        claims: intOrNull(counters.claims) ?? 0,
        jobsProcessed: intOrNull(counters.jobsProcessed) ?? 0,
        repliesReused: intOrNull(counters.repliesReused) ?? 0,
        completesAccepted: intOrNull(counters.completesAccepted) ?? 0,
        completesRejected: intOrNull(counters.completesRejected) ?? 0,
        failuresReported: intOrNull(counters.failuresReported) ?? 0,
        scopeRejected: intOrNull(counters.scopeRejected) ?? 0,
        invalidClaims: intOrNull(counters.invalidClaims) ?? 0,
        hashUnverified: intOrNull(counters.hashUnverified) ?? 0,
        transportErrors: intOrNull(counters.transportErrors) ?? 0,
        internalErrors: intOrNull(counters.internalErrors) ?? 0,
      },
      lastClaimAt: isoOrNull(worker.lastClaimAt),
      lastCompleteAt: isoOrNull(worker.lastCompleteAt),
      lastTransport: lastTransport
        ? {
            operation: reasonOrNull(lastTransport.operation),
            status: intOrNull(lastTransport.status),
            category: reasonOrNull(lastTransport.category),
            at: isoOrNull(lastTransport.at),
          }
        : null,
    },
    runtime: {
      ...publicRuntimeStatus(input.runtime),
      version: typeof input.runtime?.version === 'string' && /^\d+\.\d+\.\d+$/.test(input.runtime.version) ? input.runtime.version : null,
      loginPending: bool(input.loginPending),
    },
    server: {
      lastHeartbeatAt: isoOrNull(server.lastHeartbeatAt),
      lastHeartbeatOkAt: isoOrNull(server.lastHeartbeatOkAt),
      lastHeartbeatOk: bool(server.lastHeartbeatOk),
      lastHeartbeatStatus: intOrNull(server.lastHeartbeatStatus),
      serverTime: isoOrNull(server.serverTime),
      stats: sanitizeServerStats(server.stats),
    },
  };
}

/* Атомарная запись: временный файл рядом, затем переименование поверх прежнего. */
function writeStatusFile(filePath, document) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, {recursive: true});
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {mode: 0o600});
  fs.renameSync(temporary, filePath);
}

function createStatusWriter(filePath) {
  return (document) => writeStatusFile(filePath, document);
}

module.exports = {
  STATUS_SCHEMA,
  publicRuntimeStatus,
  sanitizeServerStats,
  buildStatusDocument,
  writeStatusFile,
  createStatusWriter,
};
