'use strict';

/* Synapse Business — приватный рантайм Hugh: безопасные ошибки.
   Наружу уходят только фиксированный код и краткое сообщение.
   Поле internal остаётся в процессе: туда попадают сырые данные Codex, их нельзя отдавать клиенту. */

class RuntimeError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.internal = options.internal ?? '';
  }

  toPublic() {
    return {error: this.message, errorCode: this.code};
  }
}

const invalid = (message) => new RuntimeError(400, 'INVALID_BODY', message);
const unauthorized = (code = 'UNAUTHORIZED') => new RuntimeError(401, code, 'Доступ запрещён');
const conflict = (message) => new RuntimeError(409, 'JOB_CONFLICT', message);
const busy = () => new RuntimeError(429, 'BUSY', 'Рантайм занят другим заданием', {retryAfterSeconds: 5});
const unavailable = (code, message) => new RuntimeError(503, code, message);

module.exports = {RuntimeError, invalid, unauthorized, conflict, busy, unavailable};
