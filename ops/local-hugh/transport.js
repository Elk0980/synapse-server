'use strict';

/* Исходящий транспорт worker: только POST на четыре операции фиксированного адреса
   /content/project-chat-worker/{heartbeat,claim,renew,complete}, Bearer отдельного ключа.

   Правила:
   - production — только HTTPS; голый HTTP допускается лишь на loopback и только явным флагом
     allowInsecureLoopback (для тестов);
   - адрес проверяется строго: без логина/пароля, параметров и якоря, путь ровно один;
   - редиректы не выполняются никогда: запрос с ключом не должен уйти на другой адрес;
   - ключ живёт в замыкании и не попадает ни в ошибки, ни в возвращаемые объекты;
   - наружу уходит только категория ошибки из закрытого набора, без текстов и адресов. */

const http = require('node:http');
const https = require('node:https');

const OPERATIONS = Object.freeze(['heartbeat', 'claim', 'renew', 'complete']);
const ENDPOINT_PATH = '/content/project-chat-worker';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ENDPOINT_CHARS = 512;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const USER_AGENT = 'synapse-local-hugh/1.0';

const ERROR_CATEGORIES = Object.freeze([
  'dns',
  'network',
  'timeout',
  'tls',
  'redirect_blocked',
  'body_too_large',
  'invalid_json',
  'unknown',
]);

class TransportError extends Error {
  constructor(category, status = null) {
    super('transport_error');
    this.name = 'TransportError';
    this.category = ERROR_CATEGORIES.includes(category) ? category : 'unknown';
    this.status = status;
  }
}

class EndpointError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'EndpointError';
    this.reason = reason;
  }
}

/* Возвращает {origin, pathname, secure} либо бросает EndpointError с коротким кодом причины. */
function validateEndpoint(value, options = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_CHARS) {
    throw new EndpointError('endpoint_not_string');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new EndpointError('endpoint_unparsable');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === 'http:') {
    if (!(options.allowInsecureLoopback === true && loopback)) throw new EndpointError('endpoint_not_https');
  } else if (url.protocol !== 'https:') {
    throw new EndpointError('endpoint_not_https');
  }
  if (url.username || url.password) throw new EndpointError('endpoint_has_credentials');
  if (url.search || url.hash) throw new EndpointError('endpoint_has_query');
  if (url.pathname.replace(/\/+$/, '') !== ENDPOINT_PATH) throw new EndpointError('endpoint_path_mismatch');
  return {origin: url.origin, pathname: ENDPOINT_PATH, secure: url.protocol === 'https:'};
}

/* Сводит ошибку сокета к категории. Сообщение ошибки не используется: в нём бывает адрес. */
function classifyError(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (error && error.name === 'TransportError') return error.category;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') return 'dns';
  if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_TIMEOUT' || code === 'HUGH_TIMEOUT') return 'timeout';
  if (code === 'ECONNRESET' && error && error.message === 'aborted') return 'network';
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    code === 'EPROTO'
  ) {
    return 'tls';
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'ENETDOWN' ||
    code === 'EADDRNOTAVAIL'
  ) {
    return 'network';
  }
  return 'unknown';
}

function createTransport(options) {
  const base = validateEndpoint(options.endpoint, {allowInsecureLoopback: options.allowInsecureLoopback === true});
  const token = typeof options.token === 'string' ? options.token : '';
  if (!token) throw new EndpointError('token_missing');
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;
  const client = base.secure ? https : http;
  const authorization = `Bearer ${token}`;

  /* Возвращает {status, body}: body — разобранный JSON или null при пустом теле.
     Бросает TransportError для сетевых сбоев, редиректов и непригодного тела. */
  function post(operation, body) {
    if (!OPERATIONS.includes(operation)) return Promise.reject(new TypeError('unknown operation'));
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    const url = new URL(`${base.pathname}/${operation}`, base.origin);
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn(value);
      };
      const request = client.request(url, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json; charset=utf-8',
          'content-length': payload.length,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        ...(base.secure ? {minVersion: 'TLSv1.2', rejectUnauthorized: true} : {}),
      });
      /* Единый предел на весь запрос по настенным часам: подключение, заголовки и тело.
         Таймаут сокета (bytes idle) здесь не годится: сервер, отдающий по байту раз в 20 мс,
         держал бы запрос сколь угодно долго. */
      const expire = () => {
        if (settled) return;
        finish(reject, new TransportError('timeout'));
        request.destroy();
      };
      deadline = setTimeout(expire, timeoutMs);
      if (typeof deadline.unref === 'function') deadline.unref();
      request.on('error', (error) => finish(reject, new TransportError(classifyError(error))));
      request.on('response', (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          // Редирект не выполняется: ключ не должен уйти по другому адресу.
          response.resume();
          finish(reject, new TransportError('redirect_blocked', status));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxResponseBytes) {
            chunks.length = 0;
            finish(reject, new TransportError('body_too_large', status));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => finish(reject, new TransportError('network', status)));
        response.on('aborted', () => finish(reject, new TransportError('network', status)));
        response.on('end', () => {
          if (settled) return;
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw.trim()) {
            finish(resolve, {status, body: null});
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            finish(reject, new TransportError('invalid_json', status));
            return;
          }
          finish(resolve, {status, body: parsed});
        });
      });
      request.end(payload);
    });
  }

  return {
    post,
    // Для журналов и статуса: без ключа, без пути операции.
    secure: base.secure,
  };
}

module.exports = {
  OPERATIONS,
  ENDPOINT_PATH,
  ERROR_CATEGORIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  TransportError,
  EndpointError,
  validateEndpoint,
  classifyError,
  createTransport,
};
