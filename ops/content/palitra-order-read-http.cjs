'use strict';
const ROOT = '/content/palitra/order-read';
const HEADERS = Object.freeze({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) fail(415, 'UNREAD_CONTENT_TYPE', 'Ожидался JSON');
  const chunks = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > 2048) fail(413, 'UNREAD_SIZE', 'Запрос слишком большой'); chunks.push(part); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'UNREAD_JSON', 'Некорректный JSON'); }
  return value;
}
function createPalitraOrderReadHttp({ state, requireSession, requireCsrf, origin } = {}) {
  if (!state || typeof state.summary !== 'function' || typeof state.acknowledge !== 'function' || typeof state.authorize !== 'function' || typeof requireSession !== 'function' || typeof requireCsrf !== 'function'
    || typeof origin !== 'string' || new URL(origin).origin !== origin) throw new TypeError('Existing Palitra host required');
  function fresh(req, previous) {
    const session = requireSession(req);
    if (!session?.user || !Number.isSafeInteger(session.user.id) || !Number.isSafeInteger(session.user.sessionVersion)
      || (previous && (session.user.id !== previous.user.id || session.user.sessionVersion !== previous.user.sessionVersion)))
      fail(403, 'UNREAD_ACCESS', 'Доступ изменился');
    state.authorize(session.user);
    return session;
  }
  async function handle({ request: req, url, reply }) {
    if (url.pathname !== ROOT && !url.pathname.startsWith(ROOT + '/')) return false;
    try {
      const session = fresh(req);
      if (![ROOT + '/summary', ROOT + '/ack'].includes(url.pathname)) fail(404, 'UNREAD_ROUTE', 'Не найдено');
      if (url.search) fail(400, 'UNREAD_QUERY', 'Параметры адреса не поддерживаются');
      const method = url.pathname.endsWith('/summary') ? 'GET' : 'POST';
      if (req.method !== method) {
        reply(405, { ok: false, code: 'UNREAD_METHOD', error: 'Метод не поддерживается' }, { ...HEADERS, allow: method });
        return true;
      }
      if ((req.headers.origin !== undefined && req.headers.origin !== origin)
        || (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])))
        fail(403, 'UNREAD_ORIGIN', 'Запрос с этого адреса не принимается');
      if (method === 'GET') {
        if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) fail(400, 'UNREAD_BODY', 'Тело запроса не поддерживается');
        const result = state.summary(session.user); fresh(req, session);
        reply(200, result, HEADERS); return true;
      }
      if (req.headers.origin !== origin) fail(403, 'UNREAD_ORIGIN', 'Запрос с этого адреса не принимается');
      requireCsrf(req, session);
      const value = await body(req), current = fresh(req, session);
      requireCsrf(req, current);
      const result = state.acknowledge(current.user, value);
      fresh(req, current); reply(200, result, HEADERS); return true;
    } catch (error) {
      const status = [400,401,403,404,405,409,413,415,503].includes(error?.status) ? error.status : 500;
      reply(status, { ok: false, code: status === 500 ? 'UNREAD_INTERNAL' : String(error.code || 'UNREAD_ACCESS'),
        error: status === 500 ? 'Счётчик сообщений временно недоступен' : String(error.message || 'Запрос не принят').slice(0, 250) }, HEADERS);
      return true;
    }
  }
  return Object.freeze({ handle });
}
module.exports = { createPalitraOrderReadHttp };
