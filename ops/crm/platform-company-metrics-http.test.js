'use strict';
/* Реальные маршруты /platform-demand/company-metrics: права, коды, no-store и изоляция.
   Компании, организации, филиалы и числа синтетические. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createPlatformDemand} = require('./platform-demand');
const {createPlatformCompanyMetrics} = require('./platform-company-metrics');
const {createPlatformDemandHandler} = require('./platform-demand-http');

const ORG = '70000000000000201', BRANCH = '70000000000000202';
const CABINET = `https://account.2gis.com/orgs/${ORG}/stats`;
const day = (index) => `2026-09-${String(index).padStart(2, '0')}`;
const report = (over = {}) => ({reportKind: 'appearance', periodStart: day(1), periodEnd: day(2), granularity: 'day',
  timezone: null, capturedDate: '2026-09-29', capturedAt: null, sourceKind: 'official_xlsx', sourceUrl: CABINET,
  originalFilename: 'appearance.xlsx', originalFileSha256: 'a'.repeat(64), scopeNote: null,
  rows: [{date: day(1), metric: 'appearance_views', value: 10, sourcePosition: 'A2'},
         {date: day(2), metric: 'appearance_views', value: 20, sourcePosition: 'A3'}], ...over});

function harness(t, {permissions = ['analytics.view', 'crm.edit']} = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name) VALUES(1,'demo-a','Компания А'),(2,'demo-b','Компания Б');`);
  const now = () => Date.parse('2026-09-30T05:00:00Z');
  const demand = createPlatformDemand(db, {now});
  const companyMetrics = createPlatformCompanyMetrics(db, {now});
  demand.saveSettings('demo-a', {revision: 0, organizationId: ORG, organizationName: 'Демо', city: 'Демоград',
    cabinetUrl: CABINET, branchId: BRANCH}, {userId: 1, userName: 'Влад'});
  const scopes = [];
  const handle = createPlatformDemandHandler({
    demand, companyMetrics,
    companyModuleContext: (request, code, permission) => {
      scopes.push({method: request.method, permission, code});
      if (!permissions.includes(permission)) { const error = Object.assign(Error('Нет доступа.'), {code: 'FORBIDDEN', status: 403}); throw error; }
      return {company: {code}, identity: {userId: 1, userName: 'Влад', permissions}};
    },
    readJson: async (request) => request.body,
    send: (response, status, payload, headers) => { response.sent = {status, payload, headers}; },
  });
  const call = async (method, path, {body = null, search = ''} = {}) => {
    const url = new URL('https://x' + path + search);
    const response = {};
    const handled = await handle({method, body}, response, url, {});
    return {handled, ...response.sent};
  };
  return {db, demand, companyMetrics, call, scopes};
}
const seed = (h, code = 'demo-a', list = [report()]) => {
  const seen = h.companyMetrics.preview(code, {reports: list}, {userId: 1});
  return h.companyMetrics.importReports(code, {settingsRevision: h.demand.get(code).settings.revision,
    dataRevision: seen.dataRevision, packageHash: seen.packageHash, confirmReplace: seen.requiresConfirmation, reports: list}, {userId: 1});
};

test('чтение требует analytics.view, запись — crm.edit, ответы без кеша', async (t) => {
  const h = harness(t);
  seed(h);
  const read = await h.call('GET', '/platform-demand/company-metrics', {search: `?companyCode=demo-a&from=${day(1)}&to=${day(3)}`});
  assert.equal(read.status, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(read.payload.metrics.find((item) => item.metric === 'appearance_views').total, 30);
  const preview = await h.call('POST', '/platform-demand/company-metrics/preview',
    {search: '?companyCode=demo-a', body: {reports: [report({periodStart: day(3), periodEnd: day(3),
      rows: [{date: day(3), metric: 'appearance_views', value: 5, sourcePosition: 'A2'}]})]}});
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['cache-control'], 'no-store');
  assert.deepEqual(h.scopes.map((item) => item.permission), ['analytics.view', 'crm.edit']);
});

test('импорт отдаёт 201 на принятый пакет и 200 на повтор; устаревший предпросмотр — 409 без записи', async (t) => {
  const h = harness(t);
  const preview = await h.call('POST', '/platform-demand/company-metrics/preview',
    {search: '?companyCode=demo-a', body: {reports: [report()]}});
  const revision = h.demand.get('demo-a').settings.revision;
  const body = {settingsRevision: revision, dataRevision: preview.payload.dataRevision,
    packageHash: preview.payload.packageHash, confirmReplace: false, reports: [report()]};
  const created = await h.call('POST', '/platform-demand/company-metrics/import', {search: '?companyCode=demo-a', body});
  assert.equal(created.status, 201);
  assert.equal(created.payload.imported.length, 1);
  const repeated = await h.call('POST', '/platform-demand/company-metrics/import',
    {search: '?companyCode=demo-a', body: {...body, dataRevision: created.payload.dataRevision}});
  assert.equal(repeated.status, 200, 'повтор ничего не добавил');
  assert.equal(repeated.payload.imported.length, 0);
  const stale = await h.call('POST', '/platform-demand/company-metrics/import', {search: '?companyCode=demo-a', body});
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, 'PREVIEW_STALE');
  assert.equal(stale.headers['cache-control'], 'no-store');
  const after = await h.call('GET', '/platform-demand/company-metrics', {search: `?companyCode=demo-a&from=${day(1)}&to=${day(3)}`});
  assert.equal(after.payload.metrics.find((item) => item.metric === 'appearance_views').total, 30, 'ничего не переписалось');
});

test('аналитик без crm.edit читает, но импортировать не может', async (t) => {
  const h = harness(t, {permissions: ['analytics.view']});
  seed(h);
  const read = await h.call('GET', '/platform-demand/company-metrics', {search: `?companyCode=demo-a&from=${day(1)}&to=${day(3)}`});
  assert.equal(read.status, 200);
  await assert.rejects(() => h.call('POST', '/platform-demand/company-metrics/import',
    {search: '?companyCode=demo-a', body: {settingsRevision: 1, dataRevision: 1, packageHash: 'a'.repeat(64), confirmReplace: false, reports: [report()]}}),
    (error) => error.status === 403);
  const stored = await h.call('GET', '/platform-demand/company-metrics', {search: `?companyCode=demo-a&from=${day(1)}&to=${day(3)}`});
  assert.equal(stored.payload.reports.length, 1, 'импорта не было');
});

test('чужие и неверные данные не сохраняются, коды ошибок доходят до клиента', async (t) => {
  const h = harness(t);
  seed(h);
  // Компания без настроенного филиала.
  const missing = await h.call('GET', '/platform-demand/company-metrics', {search: `?companyCode=demo-b&from=${day(1)}&to=${day(3)}`});
  assert.equal(missing.status, 409);
  assert.equal(missing.payload.code, 'CONFIGURATION_REQUIRED');
  // Ссылка на чужой филиал той же организации.
  const wrong = await h.call('POST', '/platform-demand/company-metrics/preview', {search: '?companyCode=demo-a',
    body: {reports: [report({sourceUrl: `https://account.2gis.com/orgs/${ORG}/branches/70000000000000999/stats`})]}});
  assert.equal(wrong.status, 409);
  assert.equal(wrong.payload.code, 'ORG_MISMATCH');
  // Неизвестное поле в отчёте.
  const junk = await h.call('POST', '/platform-demand/company-metrics/preview', {search: '?companyCode=demo-a',
    body: {reports: [{...report(), unexpected: 1}]}});
  assert.equal(junk.status, 400);
  assert.equal(junk.payload.code, 'VALIDATION_ERROR');
  // Отчёт другой компании по идентификатору не отдаётся.
  const mine = await h.call('GET', '/platform-demand/company-metrics', {search: `?companyCode=demo-a&from=${day(1)}&to=${day(3)}`});
  const id = mine.payload.reports[0].id;
  const alien = await h.call('GET', `/platform-demand/company-metrics/reports/${id}`, {search: '?companyCode=demo-b'});
  assert.equal(alien.status, 409);
  const method = await h.call('DELETE', '/platform-demand/company-metrics', {search: '?companyCode=demo-a'});
  assert.equal(method.status, 405);
  assert.equal(method.headers['cache-control'], 'no-store');
});

test('маршруты спроса по рубрикам продолжают работать рядом с показателями', async (t) => {
  const h = harness(t);
  const demand = await h.call('GET', '/platform-demand', {search: '?companyCode=demo-a'});
  assert.equal(demand.status, 200);
  assert.equal(demand.payload.settings.branchConfirmed, true);
  assert.equal(demand.headers['cache-control'], 'no-store');
});
