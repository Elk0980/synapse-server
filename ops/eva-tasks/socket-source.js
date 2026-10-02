'use strict';

const http = require('node:http');
const { isAbsolute } = require('node:path');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TASKS = 10000;
const TIMEOUT_MS = 10000;
const MAX_AGE_MS = 3 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30000;
const TASK_KEYS = new Set(['id', 'title', 'companyCode', 'companyName', 'status', 'dueAt', 'nextAction', 'blocker', 'waitingForOwner']);
const ROOT_KEYS = new Set(['version', 'readAt', 'tasks']);
const STRING_LIMITS = { title: 4096, companyCode: 256, companyName: 4096, status: 128, nextAction: 65536, blocker: 32768 };

class TaskSourceError extends Error {
  constructor() {
    super('task_source_unavailable');
    this.name = 'EvaTaskSourceError';
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.size && Object.keys(value).every(key => keys.has(key));
}

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

function validateEnvelope(value, nowMs) {
  if (!exactKeys(value, ROOT_KEYS) || value.version !== 1 || !Number.isFinite(nowMs)
      || typeof value.readAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.readAt)
      || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) throw new TaskSourceError();
  const readAt = new Date(value.readAt);
  const timestamp = readAt.getTime();
  if (!Number.isFinite(timestamp) || readAt.toISOString() !== value.readAt
      || nowMs - timestamp > MAX_AGE_MS || timestamp - nowMs > MAX_CLOCK_SKEW_MS) throw new TaskSourceError();
  const ids = new Set();
  return value.tasks.map(task => {
    if (!exactKeys(task, TASK_KEYS) || !Number.isSafeInteger(task.id) || task.id <= 0 || ids.has(task.id)
        || Object.entries(STRING_LIMITS).some(([key, limit]) => typeof task[key] !== 'string' || task[key].length > limit)
        || !task.companyCode.trim() || (task.dueAt !== null && task.dueAt !== 'invalid' && !calendarDay(task.dueAt))
        || ![null, true, false].includes(task.waitingForOwner)) throw new TaskSourceError();
    ids.add(task.id);
    // Copy only the agreed projection. No entire CRM row, credentials or metadata.
    return { id: task.id, title: task.title, companyCode: task.companyCode, companyName: task.companyName,
      status: task.status, dueAt: task.dueAt, nextAction: task.nextAction, blocker: task.blocker,
      waitingForOwner: task.waitingForOwner };
  });
}

/**
 * UDS-only client for the CRM's explicitly scoped task projection. It has no DB
 * access, bearer token, TCP fallback, redirect handling, task cache or task writes.
 * Every read requires a fresh versioned response. close() aborts outstanding reads.
 */
function createTaskSource({ socketPath, requestImpl = http.request, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof socketPath !== 'string' || !socketPath || socketPath.includes('\0') || !isAbsolute(socketPath)
      || typeof requestImpl !== 'function' || typeof now !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw new TaskSourceError();
  let closed = false;
  const pending = new Set();

  return {
    async listTasks() {
      if (closed) throw new TaskSourceError();
      return new Promise((resolve, reject) => {
        let request;
        let response;
        let settled = false;
        let ended = false;
        let size = 0;
        let chunks = [];
        let timer;

        function finish(error, tasks) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(fail);
          chunks = [];
          if (error) {
            // Destroy without the original error: it can contain paths or payloads.
            try { response?.destroy(); } catch {}
            try { request?.destroy(); } catch {}
            reject(new TaskSourceError());
          } else resolve(tasks);
        }
        function fail() { finish(true); }
        pending.add(fail);
        timer = setTimeout(fail, timeoutMs); // Total deadline also bounds slow trickles.

        try {
          request = requestImpl({ socketPath, method: 'GET', path: '/v1/tasks', agent: false,
            headers: { accept: 'application/json', 'cache-control': 'no-store' } }, incoming => {
            response = incoming;
            response.on('error', fail);
            response.on('aborted', fail);
            response.on('close', () => { if (!ended) fail(); });
            if (settled) { try { response.destroy(); } catch {} return; }
            const length = response.headers?.['content-length'];
            if (response.statusCode !== 200
                || typeof response.headers?.['content-type'] !== 'string'
                || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'])
                || (response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity')
                || (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
              fail(); return;
            }
            response.on('data', chunk => {
              if (settled) return;
              try {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.length;
                if (size > MAX_BYTES) { fail(); return; }
                chunks.push(bytes);
              } catch { fail(); }
            });
            response.on('end', () => {
              ended = true;
              if (settled) return;
              try {
                if (response.complete === false || (length !== undefined && size !== Number(length))) throw new TaskSourceError();
                const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
                finish(false, validateEnvelope(envelope, now()));
              } catch { fail(); }
            });
          });
          request.on('error', fail);
          request.end();
          if (settled) { try { request.destroy(); } catch {} }
        } catch { fail(); }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const fail of [...pending]) fail();
    },
  };
}

module.exports = { createTaskSource, TaskSourceError };
