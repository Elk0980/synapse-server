'use strict';

/* Внутренний HTTP-интерфейс рантайма. Публичного маршрута у него нет:
   обращаются только сервисы chat (Authorization: Bearer) и content (X-API-Key).
   Ключ сравнивается за постоянное время, тело читается только после успешной проверки. */

const http = require('node:http');
const crypto = require('node:crypto');
const {RuntimeError, invalid, unauthorized} = require('./errors');
const {LIMITS, validateReplyPayload, canonicalPayload} = require('./limits');

/* Ответы, после которых бэкенд просто ждёт и повторяет тот же jobId. */
const TRANSIENT_CODES = new Set(['BUSY', 'RATE_LIMITED', 'UPSTREAM_BUSY']);

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function constantTimeEquals(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

/* Принимаем оба заголовка. Если присланы оба и различаются — отказ, а не выбор «удобного». */
function extractKey(headers) {
  const authorization = headers.authorization;
  const apiKeyHeader = headers['x-api-key'];
  let bearer = null;
  if (typeof authorization === 'string' && authorization.length > 0) {
    const match = /^Bearer[ ]+(\S+)$/.exec(authorization.trim());
    if (!match) throw unauthorized();
    bearer = match[1];
  }
  const direct = typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0 ? apiKeyHeader.trim() : null;
  if (bearer && direct) {
    if (!constantTimeEquals(bearer, direct)) throw unauthorized('AUTH_CONFLICT');
    return bearer;
  }
  const key = bearer || direct;
  if (!key) throw unauthorized();
  return key;
}

function authorize(headers, apiKey) {
  const provided = extractKey(headers);
  if (!constantTimeEquals(provided, apiKey)) throw unauthorized();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    request.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > LIMITS.maxBodyBytes) {
        aborted = true;
        chunks.length = 0;
        reject(new RuntimeError(413, 'BODY_TOO_LARGE', 'Тело запроса больше допустимого'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(invalid('Тело запроса не является корректным JSON'));
      }
    });
    request.on('error', () => {
      if (!aborted) reject(invalid('Не удалось прочитать тело запроса'));
    });
  });
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function sendError(response, error, logger) {
  if (error instanceof RuntimeError) {
    const headers = error.retryAfterSeconds ? {'retry-after': String(error.retryAfterSeconds)} : {};
    // Недочитанное тело нельзя оставлять в keep-alive соединении.
    if (error.status === 413) headers.connection = 'close';
    const body = error.toPublic();
    if (error.retryAfterSeconds) body.retryAfter = error.retryAfterSeconds;
    sendJson(response, error.status, body, headers);
    return;
  }
  // Сырые сообщения и стеки наружу не уходят никогда.
  logger.error(`hugh-runtime: internal_error name=${JSON.stringify(error && error.name)}`);
  sendJson(response, 500, {error: 'Внутренняя ошибка рантайма', errorCode: 'INTERNAL_ERROR'});
}

function createHttpServer(options) {
  const {runtime, store, apiKey} = options;
  const logger = options.logger || console;
  if (!apiKey || !apiKey.trim()) throw new Error('CHAT_API_KEY обязателен');

  async function handleReply(request, response) {
    const raw = await readJsonBody(request);
    const payload = validateReplyPayload(raw);
    const hash = crypto.createHash('sha256').update(canonicalPayload(payload)).digest('hex');
    /* Область задания включает аудиторию: личная переписка владельца и общий чат той же
       компании не делят ни кэш ответа, ни повтор по jobId. Для общего чата ключ равен коду
       компании, поэтому ранее сохранённые задания находятся по-прежнему. */
    const claim = store.claim(payload.scopeKey, payload.jobId, hash);
    if (claim.reuse) {
      sendJson(response, 200, {text: claim.reuse.text, provider: 'codex', model: claim.reuse.model, reused: true});
      return;
    }
    try {
      const result = await runtime.reply(payload);
      store.complete(payload.scopeKey, payload.jobId, result.text, result.model);
      sendJson(response, 200, {text: result.text, provider: 'codex', model: result.model, reused: false});
    } catch (error) {
      const code = error instanceof RuntimeError ? error.code : 'INTERNAL_ERROR';
      // Занятость и лимит подписки — это ожидание, а не попытка: аренда снимается,
      // чтобы тот же jobId вернулся позже без конфликта и без следа неудачи.
      if (TRANSIENT_CODES.has(code)) store.release(payload.scopeKey, payload.jobId);
      else store.fail(payload.scopeKey, payload.jobId, code);
      throw error;
    }
  }

  const server = http.createServer((request, response) => {
    Promise.resolve()
      .then(async () => {
        authorize(request.headers, apiKey); // до чтения тела и до любого обращения к Codex
        const route = new URL(request.url || '/', 'http://hugh-runtime').pathname.replace(/\/+$/, '') || '/';
        if (route === '/status') {
          if (request.method !== 'GET') throw new RuntimeError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
          sendJson(response, 200, {...runtime.statusSnapshot(), limits: LIMITS});
          return;
        }
        if (route === '/login') {
          if (request.method !== 'POST') throw new RuntimeError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
          const body = await readJsonBody(request);
          const empty = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;
          if (!empty) throw invalid('Тело /login должно быть пустым');
          const status = await runtime.startLogin();
          sendJson(response, 200, {...status, limits: LIMITS});
          return;
        }
        if (route === '/reply') {
          if (request.method !== 'POST') throw new RuntimeError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
          await handleReply(request, response);
          return;
        }
        throw new RuntimeError(404, 'NOT_FOUND', 'Маршрут не найден');
      })
      .catch((error) => sendError(response, error, logger));
  });

  server.headersTimeout = 20_000;
  server.requestTimeout = 180_000;
  return server;
}

module.exports = {createHttpServer, authorize, extractKey, constantTimeEquals, readJsonBody};
