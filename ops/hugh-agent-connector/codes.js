'use strict';

/* Коды отказа контракта /content/project-chat-worker. Список закрыт сервером
   (ops/content/project-chat-local-worker.js): ничего сверх него отправлять нельзя.
   Тексты ошибок, адреса и переписка наружу не уходят — пояснение для чата сервер пишет сам. */

const CONTRACT_ERROR_CODES = Object.freeze([
  'LOGIN_REQUIRED', 'UNAVAILABLE', 'BUSY', 'RATE_LIMITED', 'INVALID_PAYLOAD', 'SAFETY_REJECTED', 'INTERNAL_ERROR',
]);

const DEFAULT_RETRY_AFTER = Object.freeze({
  LOGIN_REQUIRED: 120, UNAVAILABLE: 60, BUSY: 5, RATE_LIMITED: 300,
  INVALID_PAYLOAD: 0, SAFETY_REJECTED: 600, INTERNAL_ERROR: 60,
});

const MAX_RETRY_AFTER_SECONDS = 6 * 3600;

/* null и '' означают «срок не назван», а не ноль: Number(null) дал бы 0 и затёр запасное значение. */
function clampRetryAfter(value, fallback) {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.trunc(number));
}

function failure(code, retryAfter) {
  const errorCode = CONTRACT_ERROR_CODES.includes(code) ? code : 'INTERNAL_ERROR';
  return { ok: false, errorCode, retryAfter: clampRetryAfter(retryAfter, DEFAULT_RETRY_AFTER[errorCode]) };
}

/* Любая ошибка адаптера сводится к коду контракта по её полю code. Текст ошибки не используется. */
const ADAPTER_CODE_MAP = new Map([
  ['AGENT_TIMEOUT', 'UNAVAILABLE'],
  ['AGENT_NOT_FOUND', 'UNAVAILABLE'],
  ['AGENT_FAILED', 'UNAVAILABLE'],
  ['AGENT_EMPTY', 'UNAVAILABLE'],
  ['AGENT_OUTPUT_TOO_LARGE', 'INVALID_PAYLOAD'],
  ['AGENT_BAD_OUTPUT', 'INVALID_PAYLOAD'],
  ['AGENT_RATE_LIMITED', 'RATE_LIMITED'],
  ['AGENT_BUSY', 'BUSY'],
  ['AGENT_CREDENTIALS_MISSING', 'UNAVAILABLE'],
  ['SPAWN_GUARD_FAILED', 'SAFETY_REJECTED'],
  ['FOREIGN_COMPANY', 'INVALID_PAYLOAD'],
  ['PAYLOAD_INVALID', 'INVALID_PAYLOAD'],
]);

function toFailure(error) {
  const code = ADAPTER_CODE_MAP.get(String(error?.code || '')) || 'INTERNAL_ERROR';
  return failure(code, error?.retryAfterSeconds);
}

class AgentError extends Error {
  constructor(code, retryAfterSeconds = null) {
    super(code);
    this.name = 'AgentError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

module.exports = { CONTRACT_ERROR_CODES, DEFAULT_RETRY_AFTER, MAX_RETRY_AFTER_SECONDS, clampRetryAfter, failure, toFailure, AgentError, ADAPTER_CODE_MAP };
