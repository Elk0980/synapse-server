'use strict';

// Только отчёты: токены остаются на сервере, данные не складываются с событиями CRM.
function createMetrika({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  return async function report(companyCode, from, to) {
    const validDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDay(from) || !validDay(to) || from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000) {
      const error = new Error('Выберите корректный период не больше года'); error.status = 400; throw error;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(companyCode)) throw new Error('Invalid company');
    // Не нормализуем дефисы в подчёркивания: разные коды компаний не должны делить секрет.
    const suffix = companyCode.toUpperCase();
    const counterId = String(env[`METRIKA_COUNTER_${suffix}`] || '');
    const token = String(env[`METRIKA_TOKEN_${suffix}`] || '').trim();
    const base = { companyCode, from, to, counterId: /^\d+$/.test(counterId) ? counterId : null,
      metrics: null, fetchedAt: null, sampled: null };
    if (!/^\d{1,12}$/.test(counterId) || !token) return { ...base, status: 'not_configured' };
    const key = `${companyCode}:${counterId}:${from}:${to}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < 300000 && cached.token === token) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      try {
        const url = new URL('https://api-metrika.yandex.net/stat/v1/data');
        url.search = new URLSearchParams({ ids: counterId, date1: from, date2: to,
          metrics: 'ym:s:visits,ym:s:users,ym:s:pageviews', accuracy: 'full', lang: 'ru' });
        const response = await fetchImpl(url, { headers: { Authorization: `OAuth ${token}` },
          redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) return { ...base, status: [401, 403].includes(response.status) ? 'access_denied' :
          response.status === 429 ? 'rate_limited' : 'unavailable' };
        const body = await response.json();
        if (!Array.isArray(body.totals) || body.totals.length !== 3 ||
            body.totals.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
          return { ...base, status: 'invalid_response' };
        }
        const value = { ...base, status: 'ok', fetchedAt: new Date(now()).toISOString(),
          sampled: body.sampled === true, metrics: { visits: body.totals[0], users: body.totals[1], pageViews: body.totals[2] } };
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now(), token, value });
        return value;
      } catch { return { ...base, status: 'unavailable' }; }
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}
module.exports = { createMetrika };
