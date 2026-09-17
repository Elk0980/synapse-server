'use strict';

/* Закрытый список кодов отказа для complete по контракту docs/local-hugh-worker-contract.md.
   Любой код рантайма сводится к одному из семи; сырые сообщения и стеки наружу не уходят,
   сервер формирует пояснения для чата сам. Неизвестное — всегда INTERNAL_ERROR. */

const {RuntimeError} = require('../hugh-runtime/errors');

const CONTRACT_ERROR_CODES = Object.freeze([
  'LOGIN_REQUIRED',
  'UNAVAILABLE',
  'BUSY',
  'RATE_LIMITED',
  'INVALID_PAYLOAD',
  'SAFETY_REJECTED',
  'INTERNAL_ERROR',
]);

/* Соответствие кодов HughRuntime (runtime.js, errors.js, job-store.js) кодам контракта. */
const RUNTIME_CODE_MAP = new Map([
  ['LOGIN_REQUIRED', 'LOGIN_REQUIRED'],
  ['LOGIN_FAILED', 'UNAVAILABLE'],
  ['LOGIN_REJECTED', 'UNAVAILABLE'],
  ['BUSY', 'BUSY'],
  ['RATE_LIMITED', 'RATE_LIMITED'],
  ['UPSTREAM_BUSY', 'RATE_LIMITED'],
  ['INVALID_BODY', 'INVALID_PAYLOAD'],
  ['CONTEXT_TOO_LARGE', 'INVALID_PAYLOAD'],
  ['TOOL_ISOLATION_VIOLATION', 'SAFETY_REJECTED'],
  ['TOOL_ISOLATION_UNVERIFIED', 'SAFETY_REJECTED'],
  ['ENVIRONMENT_GUARD_FAILED', 'SAFETY_REJECTED'],
  ['MODEL_MISMATCH', 'SAFETY_REJECTED'],
  ['MODEL_CATALOG_REJECTED', 'SAFETY_REJECTED'],
  ['VERSION_MISMATCH', 'UNAVAILABLE'],
  ['RUNTIME_UNAVAILABLE', 'UNAVAILABLE'],
  ['UPSTREAM_ERROR', 'UNAVAILABLE'],
  ['TIMEOUT', 'UNAVAILABLE'],
  ['EMPTY_REPLY', 'UNAVAILABLE'],
  ['TURN_INTERRUPTED', 'UNAVAILABLE'],
  ['JOB_CONFLICT', 'INTERNAL_ERROR'],
]);

/* Секунды ожидания по умолчанию, когда рантайм сам не назвал срок. */
const DEFAULT_RETRY_AFTER = Object.freeze({
  LOGIN_REQUIRED: 120,
  UNAVAILABLE: 60,
  BUSY: 5,
  RATE_LIMITED: 300,
  INVALID_PAYLOAD: 0,
  SAFETY_REJECTED: 600,
  INTERNAL_ERROR: 60,
});

const MAX_RETRY_AFTER_SECONDS = 6 * 3600;

/* null/undefined — это «срок не назван», а не ноль: Number(null) даёт 0 и терял бы fallback. */
function clampRetryAfter(value, fallback) {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.trunc(number));
}

function contractFailure(code, retryAfter) {
  const errorCode = CONTRACT_ERROR_CODES.includes(code) ? code : 'INTERNAL_ERROR';
  return {ok: false, errorCode, retryAfter: clampRetryAfter(retryAfter, DEFAULT_RETRY_AFTER[errorCode])};
}

/* Переводит любую ошибку в конверт отказа контракта. Текст ошибки не используется вовсе. */
function toContractFailure(error) {
  if (error instanceof RuntimeError) {
    const code = RUNTIME_CODE_MAP.get(error.code) || 'INTERNAL_ERROR';
    return contractFailure(code, error.retryAfterSeconds);
  }
  return contractFailure('INTERNAL_ERROR');
}

module.exports = {
  CONTRACT_ERROR_CODES,
  RUNTIME_CODE_MAP,
  DEFAULT_RETRY_AFTER,
  MAX_RETRY_AFTER_SECONDS,
  contractFailure,
  toContractFailure,
};
