'use strict';
const { SOCIAL_STATS_ERRORS } = require('./social-stats');
/* Маршруты аналитики соцсетей: чтение — analytics.view, настройки/импорт/сбор — crm.edit (настройки и импорт — только владелец). */
function createSocialStatsHandler({ stats, companyModuleContext, readJson, send }) {
  return async function handle(request, response, url, cors = {}) {
    if (!/^\/social-stats(?:\/|$)/.test(url.pathname)) return false;
    const headers = { ...cors, 'cache-control': 'no-store' };
    const readOnly = request.method === 'GET';
    const { company, identity } = companyModuleContext(request, url.searchParams.get('companyCode'), readOnly ? 'analytics.view' : 'crm.edit');
    const ownerOnly = () => { if (identity.role !== 'owner') { send(response, 403, { error: 'Настройки аккаунтов и ручной импорт доступны владельцу', code: 'FORBIDDEN' }, headers); return false; } return true; };
    try {
      let result;
      if (url.pathname === '/social-stats' && readOnly) {
        const to = url.searchParams.get('to') || stats.localDay(Date.now(), 'Asia/Bangkok');
        const from = url.searchParams.get('from') || new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
        result = stats.overview(company.code, from, to);
      } else if (url.pathname === '/social-stats/accounts' && readOnly) result = stats.accounts(company.code);
      else if (url.pathname === '/social-stats/accounts' && request.method === 'PUT') { if (!ownerOnly()) return true; result = stats.saveAccounts(company.code, await readJson(request)); }
      else if (url.pathname === '/social-stats/import' && request.method === 'POST') { if (!ownerOnly()) return true; result = stats.importManual(company.code, await readJson(request), identity); }
      else if (url.pathname === '/social-stats/collect' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !['platform', 'date'].includes(k))) { send(response, 400, { error: SOCIAL_STATS_ERRORS.VALIDATION_ERROR, code: 'VALIDATION_ERROR' }, headers); return true; }
        result = await stats.collect(company.code, body.platform, { trigger: `manual:${identity.userId}`, date: body.date || null });
      } else { send(response, 405, { error: 'Метод не поддерживается.', code: 'METHOD_NOT_ALLOWED' }, headers); return true; }
      send(response, 200, result, headers);
    } catch (error) {
      if (!Object.hasOwn(SOCIAL_STATS_ERRORS, error.code)) throw error;
      send(response, error.status, { error: SOCIAL_STATS_ERRORS[error.code], code: error.code, ...(error.field ? { field: error.field } : {}) }, headers);
    }
    return true;
  };
}
module.exports = { createSocialStatsHandler };
