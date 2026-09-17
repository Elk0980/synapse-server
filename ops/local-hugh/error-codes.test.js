'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {RuntimeError, unavailable, invalid, conflict, busy} = require('../hugh-runtime/errors');
const {CONTRACT_ERROR_CODES, RUNTIME_CODE_MAP, toContractFailure, contractFailure} = require('./error-codes');

test('все значения таблицы соответствий входят в закрытый список', () => {
  assert.deepEqual(CONTRACT_ERROR_CODES, ['LOGIN_REQUIRED', 'UNAVAILABLE', 'BUSY', 'RATE_LIMITED', 'INVALID_PAYLOAD', 'SAFETY_REJECTED', 'INTERNAL_ERROR']);
  for (const value of RUNTIME_CODE_MAP.values()) assert.ok(CONTRACT_ERROR_CODES.includes(value), value);
});

test('toContractFailure: коды рантайма, retryAfter и неизвестные ошибки', () => {
  assert.deepEqual(toContractFailure(new RuntimeError(429, 'RATE_LIMITED', 'x', {retryAfterSeconds: 42})), {ok: false, errorCode: 'RATE_LIMITED', retryAfter: 42});
  assert.deepEqual(toContractFailure(unavailable('UPSTREAM_BUSY', 'x')), {ok: false, errorCode: 'RATE_LIMITED', retryAfter: 300});
  assert.deepEqual(toContractFailure(busy()), {ok: false, errorCode: 'BUSY', retryAfter: 5});
  assert.deepEqual(toContractFailure(invalid('x')), {ok: false, errorCode: 'INVALID_PAYLOAD', retryAfter: 0});
  assert.deepEqual(toContractFailure(conflict('x')), {ok: false, errorCode: 'INTERNAL_ERROR', retryAfter: 60});
  assert.deepEqual(toContractFailure(unavailable('MODEL_MISMATCH', 'x')), {ok: false, errorCode: 'SAFETY_REJECTED', retryAfter: 600});
  assert.deepEqual(toContractFailure(unavailable('SOMETHING_NEW', 'x')), {ok: false, errorCode: 'INTERNAL_ERROR', retryAfter: 60});
  assert.deepEqual(toContractFailure(new Error('raw')), {ok: false, errorCode: 'INTERNAL_ERROR', retryAfter: 60});
  assert.deepEqual(toContractFailure(null), {ok: false, errorCode: 'INTERNAL_ERROR', retryAfter: 60});
  assert.deepEqual(contractFailure('LOGIN_REQUIRED', 999_999), {ok: false, errorCode: 'LOGIN_REQUIRED', retryAfter: 21600});
  assert.deepEqual(contractFailure('NOT_A_CODE'), {ok: false, errorCode: 'INTERNAL_ERROR', retryAfter: 60});
  // RuntimeError без retryAfterSeconds хранит null: это отсутствие срока, а не ноль.
  assert.deepEqual(toContractFailure(new RuntimeError(503, 'LOGIN_REQUIRED', 'x')), {ok: false, errorCode: 'LOGIN_REQUIRED', retryAfter: 120});
  assert.deepEqual(toContractFailure(new RuntimeError(429, 'RATE_LIMITED', 'x', {retryAfterSeconds: null})), {ok: false, errorCode: 'RATE_LIMITED', retryAfter: 300});
  assert.deepEqual(contractFailure('UNAVAILABLE', undefined), {ok: false, errorCode: 'UNAVAILABLE', retryAfter: 60});
  assert.deepEqual(contractFailure('UNAVAILABLE', null), {ok: false, errorCode: 'UNAVAILABLE', retryAfter: 60});
  assert.deepEqual(contractFailure('UNAVAILABLE', ''), {ok: false, errorCode: 'UNAVAILABLE', retryAfter: 60});
  assert.deepEqual(contractFailure('UNAVAILABLE', 0), {ok: false, errorCode: 'UNAVAILABLE', retryAfter: 0}, 'явный ноль остаётся нулём');
  const failure = toContractFailure(new RuntimeError(503, 'LOGIN_FAILED', 'сырое сообщение с адресом'));
  assert.equal(Object.keys(failure).length, 3);
  assert.ok(!JSON.stringify(failure).includes('сырое'));
});
