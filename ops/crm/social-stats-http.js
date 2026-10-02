'use strict';
const { SOCIAL_STATS_ERRORS } = require('./social-stats');
const { previousPeriod } = require('./social-insights');
/* Маршруты аналитики соцсетей: чтение — analytics.view, настройки/импорт/сбор — crm.edit (настройки и импорт — только владелец). */
/* Отказы аналитического источника переводятся в HTTP здесь. Сообщения общие: ни ключа,
   ни адреса с ключом в строке запроса, ни текста ответа источника наружу не выходит. */
const ANALYTICS_HTTP = Object.freeze({
  MISSING_ACCESS: [409, 'Аналитический доступ не настроен: сохраните ключ Onlypult Analytics.'],
  CREDENTIAL_UNREADABLE: [409, 'Сохранённый аналитический доступ не читается: сохраните ключ заново.'],
  ACCESS_DENIED: [502, 'Источник отклонил аналитический доступ: ключ не принят или не даёт прав на аналитику.'],
  NOT_FOUND: [502, 'Аналитический профиль или раздел у источника не найден.'],
  UNSUPPORTED: [502, 'Источник не поддерживает такой запрос для этого профиля.'],
  RATE_LIMITED: [503, 'Источник временно ограничил обращения: повторите позже.'],
  UPSTREAM_ERROR: [502, 'Источник вернул ошибку.'],
  TIMEOUT: [504, 'Источник не ответил вовремя.'],
  CONNECTION_UNCERTAIN: [504, 'Источник не ответил.'],
  RESPONSE_TOO_LARGE: [502, 'Ответ источника слишком большой.'],
  RESPONSE_UNCERTAIN: [502, 'Ответ источника не разобран.'],
  BAD_ENDPOINT: [500, 'Недопустимый адрес источника.'],
  BAD_PERIOD: [400, 'Неверный период запроса.'],
  BAD_TIMEZONE: [400, 'Неизвестный часовой пояс.'],
  PROFILE_CHANGED: [409, 'Ответ источника относится к другому аналитическому профилю.'],
  ACCOUNT_CHANGED: [409, 'Ответ источника относится к другому аккаунту площадки.'],
});
/* companyMetrics — уже существующий сервис загруженных отчётов 2ГИС. Он подключается сюда
   только для чтения сводки под ТЕМИ ЖЕ правами, что и его собственный маршрут
   /platform-demand/company-metrics (чтение — analytics.view в своей компании): нового
   доступа и новых прав здесь не появляется, хранилище не дублируется. */
function createSocialStatsHandler({ stats, baselines, analytics = null, companyMetrics = null, companyModuleContext, readJson, send }) {
  return async function handle(request, response, url, cors = {}) {
    if (!/^\/social-stats(?:\/|$)/.test(url.pathname)) return false;
    const headers = { ...cors, 'cache-control': 'no-store' };
    const readOnly = request.method === 'GET';
    const { company, identity } = companyModuleContext(request, url.searchParams.get('companyCode'), readOnly ? 'analytics.view' : 'crm.edit');
    const ownerOnly = () => { if (identity.role !== 'owner') { send(response, 403, { error: 'Настройки аккаунтов и ручной импорт доступны владельцу', code: 'FORBIDDEN' }, headers); return false; } return true; };
    try {
      let result;
      if (url.pathname === '/social-stats' && readOnly) {
        const modes = url.searchParams.getAll('crmPeriod');
        if (modes.length > 1 || (modes.length === 1 && !['project', 'utc'].includes(modes[0])))
          throw Object.assign(new Error(SOCIAL_STATS_ERRORS.VALIDATION_ERROR), { code: 'VALIDATION_ERROR', status: 400, field: 'crmPeriod' });
        const to = url.searchParams.get('to') || stats.localDay(Date.now(), 'Asia/Bangkok');
        const from = url.searchParams.get('from') || new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
        result = modes.length ? stats.overview(company.code, from, to, { crmPeriod: modes[0] }) : stats.overview(company.code, from, to);
      } else if (url.pathname === '/social-stats/baseline' && readOnly) {
        const rawVersion = url.searchParams.get('version');
        const version = rawVersion === null ? null : Number(rawVersion);
        result = baselines.get(company.code, version);
      } else if (url.pathname === '/social-stats/baseline' && request.method === 'POST') {
        if (!ownerOnly()) return true;
        result = baselines.freeze(company.code, await readJson(request), identity);
      } else if (url.pathname === '/social-stats/insights' && readOnly) {
        /* Только чтение уже сохранённого: сбор не запускается, импорт не делается,
           замер «ДО» не фиксируется. 2ГИС и выбранная версия замера подставляются как есть. */
        const to = url.searchParams.get('to') || stats.localDay(Date.now(), 'Asia/Bangkok');
        const from = url.searchParams.get('from') || new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10);
        const previous = previousPeriod(from, to);
        // Отсутствие или сбой настройки 2ГИС не должен ломать выводы по соцсетям.
        const gis = (a, b) => { try { return companyMetrics ? companyMetrics.summary(company.code, a, b) : null; } catch { return null; } };
        let baseline = null;
        try { baseline = baselines.get(company.code, null); } catch { baseline = null; }
        result = stats.insights(company.code, from, to, {
          companyMetrics: gis(from, to),
          previousCompanyMetrics: previous ? gis(previous.from, previous.to) : null,
          baseline,
        });
      } else if (url.pathname === '/social-stats/accounts' && readOnly) result = stats.accounts(company.code);
      else if (url.pathname === '/social-stats/accounts' && request.method === 'PUT') { if (!ownerOnly()) return true; result = stats.saveAccounts(company.code, await readJson(request)); }
      else if (url.pathname === '/social-stats/import' && request.method === 'POST') { if (!ownerOnly()) return true; result = stats.importManual(company.code, await readJson(request), identity); }
      else if (url.pathname === '/social-stats/collect' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !['platform', 'date'].includes(k))) { send(response, 400, { error: SOCIAL_STATS_ERRORS.VALIDATION_ERROR, code: 'VALIDATION_ERROR' }, headers); return true; }
        result = await stats.collect(company.code, body.platform, { trigger: `manual:${identity.userId}`, date: body.date || null });
      } else if (url.pathname.startsWith('/social-stats/analytics')) {
        /* Отдельный аналитический доступ Onlypult Analytics. Только владелец своей компании:
           это ключ к кабинету источника, а не настройка показа. Ключ не возвращается ни в
           одном ответе — DTO знает лишь «настроен или нет» и состояние проверки. */
        if (!analytics?.credentials) { send(response, 503, { error: 'Аналитический источник не подключён к серверу.', code: 'NOT_CONFIGURED' }, headers); return true; }
        if (!ownerOnly()) return true;
        const provider = 'onlypult_analytics';
        /* У модуля доступа свои сообщения (ревизия, формат ключа). Они уже написаны для
           владельца и секрета не содержат, поэтому отдаются как есть, а не подменяются
           общим текстом словаря social-stats. */
        try {
        if (url.pathname === '/social-stats/analytics/access' && readOnly) result = analytics.credentials.get(company.code, provider);
        else if (url.pathname === '/social-stats/analytics/access' && request.method === 'PUT') result = analytics.credentials.save(company.code, provider, await readJson(request), identity);
        else if (url.pathname === '/social-stats/analytics/access' && request.method === 'DELETE') result = analytics.credentials.remove(company.code, provider, await readJson(request), identity);
        else if (url.pathname === '/social-stats/analytics/profiles' && readOnly) {
          if (!analytics.collector) { send(response, 503, { error: 'Сборщик аналитики не подключён к серверу.', code: 'NOT_CONFIGURED' }, headers); return true; }
          /* Список профилей — он же проверка доступа: результат запоминается на текущей
             ревизии ключа, поэтому «подключено» не переезжает на новый неизвестный ключ. */
          const before = analytics.credentials.get(company.code, provider);
          try {
            const listing = await analytics.collector.listProfiles(company.code);
            analytics.credentials.markChecked(company.code, provider, { revision: before.revision, status: 'connected' });
            result = { ...listing, access: analytics.credentials.get(company.code, provider) };
          } catch (error) {
            const known = ANALYTICS_HTTP[error?.code];
            analytics.credentials.markChecked(company.code, provider, { revision: before.revision, status: 'error', code: error?.code || 'UNKNOWN' });
            if (!known) throw error;
            send(response, known[0], { error: known[1], code: error.code, access: analytics.credentials.get(company.code, provider) }, headers);
            return true;
          }
        } else { send(response, 405, { error: 'Метод не поддерживается.', code: 'METHOD_NOT_ALLOWED' }, headers); return true; }
        } catch (error) {
          const known = ANALYTICS_HTTP[error?.code];
          if (known) { send(response, known[0], { error: known[1], code: error.code }, headers); return true; }
          if (typeof error?.status === 'number' && error?.message) { send(response, error.status, { error: error.message, code: error.code || 'VALIDATION_ERROR' }, headers); return true; }
          throw error;
        }
        send(response, 200, result, headers);
        return true;
      } else { send(response, 405, { error: 'Метод не поддерживается.', code: 'METHOD_NOT_ALLOWED' }, headers); return true; }
      send(response, 200, result, headers);
    } catch (error) {
      if (!Object.hasOwn(SOCIAL_STATS_ERRORS, error.code)) throw error;
      send(response, error.status, { error: SOCIAL_STATS_ERRORS[error.code], code: error.code, ...(error.field ? { field: error.field } : {}) }, headers);
    }
    return true;
  };
}
module.exports = { createSocialStatsHandler, ANALYTICS_HTTP };
