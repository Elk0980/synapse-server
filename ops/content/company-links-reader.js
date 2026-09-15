'use strict';

const LINK_KEYS = ['website', 'two_gis', 'yandex_maps', 'max', 'telegram', 'telegram_channel', 'whatsapp', 'vk', 'booking'];
function failure(status, message) { return Object.assign(new Error(message), {status}); }
function publicLinks(payload, companyCode) {
  if (!payload || payload.companyCode !== companyCode || !payload.links || Array.isArray(payload.links) || typeof payload.links !== 'object') {
    throw failure(502, 'Не удалось получить ссылки компании');
  }
  const links = {};
  for (const key of LINK_KEYS) {
    const raw = payload.links[key];
    if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) continue;
    const value = raw.trim();
    if (!value || value.length > 2000) continue;
    try {
      const url = new URL(value);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) links[key] = value;
    } catch (_) {}
  }
  return {companyCode, links};
}
function createCompanyLinksReader({crmUrl, apiKey, companies, fetch: fetcher = globalThis.fetch}) {
  return async function readCompanyLinks(site) {
    if (!Object.hasOwn(companies, site)) throw failure(404, 'Неизвестный сайт');
    if (!apiKey) throw failure(503, 'Ссылки компании пока недоступны');
    const code = companies[site];
    let response;
    try {
      response = await fetcher(`${crmUrl}/company-links/${encodeURIComponent(code)}`, {
        headers: {'x-api-key': apiKey, accept: 'application/json'},
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
    } catch (_) { throw failure(503, 'Ссылки компании пока недоступны'); }
    if (response.status === 404) throw failure(404, 'Компания не найдена');
    if (!response.ok) throw failure(502, 'Не удалось получить ссылки компании');
    try {
      const body = await response.text();
      if (body.length > 32000) throw new Error('Response too large');
      return publicLinks(JSON.parse(body), code);
    } catch (_) { throw failure(502, 'Не удалось получить ссылки компании'); }
  };
}
module.exports = {createCompanyLinksReader, publicLinks};
