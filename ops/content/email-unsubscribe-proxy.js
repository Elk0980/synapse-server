'use strict';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const failure = (status, message) => Object.assign(new Error(message), {status});
const missing = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отписка</title><p>Ссылка отписки не найдена или недействительна.</p></html>';

function createEmailUnsubscribeProxy({crmUrl, apiKey, fetch: fetcher = globalThis.fetch}) {
  return async function unsubscribe({token, method, body = ''}) {
    if (!TOKEN.test(token || '') || !['GET', 'POST'].includes(method)) throw failure(404, 'Ссылка не найдена');
    if (typeof body !== 'string' || Buffer.byteLength(body) > 1024) throw failure(413, 'Слишком большой запрос');
    if (!apiKey) throw failure(503, 'Отписка временно недоступна');
    try {
      const upstream = await fetcher(`${crmUrl}/email-unsubscribe/${token}`, {
        method, headers: {'x-api-key': apiKey, accept: 'text/html',
          ...(method === 'POST' ? {'content-type': 'application/x-www-form-urlencoded'} : {})},
        ...(method === 'POST' ? {body} : {}),
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (upstream.status === 404) return {status: 404, html: missing};
      if (upstream.status !== 200 || !/^text\/html(?:;|$)/i.test(upstream.headers.get('content-type') || '')) throw new Error('Invalid response');
      const html = await upstream.text();
      if (Buffer.byteLength(html) > 65536) throw new Error('Response too large');
      return {status: 200, html};
    } catch (_) { throw failure(502, 'Отписка временно недоступна. Попробуйте позже.'); }
  };
}
module.exports = {createEmailUnsubscribeProxy, TOKEN};
