'use strict';
const R = require('./customer-reports.cjs');
const branches = Object.freeze({ alvi: 989844, avokado: 375899 });
const keys = ['under3', '3to6', '6to12', '1to2', 'over2', 'noVisit'];
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const invalid = () => { throw Object.assign(new Error('Срез YCLIENTS не прошёл проверку источника и периода'), { status: 400 }); };
const exactTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
// A UI aggregate never becomes fictional client/payment rows or lifetime cash LTV.
function report({ companyCode, query = {}, snapshot, now = new Date().toISOString() }) {
  const out = R.report({ companyCode, query, now });
  if (!snapshot) return out;
  if (snapshot.contract !== 'salon-client-aggregates/v1' || snapshot.companyCode !== companyCode || snapshot.branchId !== branches[companyCode] || snapshot.source !== 'yclients-ui' || !exactTime(snapshot.capturedAt) || !exactTime(snapshot.observedThrough) || Date.parse(snapshot.observedThrough) > Date.parse(snapshot.capturedAt) || Date.parse(snapshot.capturedAt) > Date.parse(now) || !Array.isArray(snapshot.periods)) invalid();
  const asOf = Math.min(Date.parse(now), Date.parse(snapshot.observedThrough), Date.parse(out.period.untilAt) - 1);
  out.source = { kind: 'yclients', method: 'native-ui-aggregate', status: 'partial', updatedAt: snapshot.capturedAt, asOf: new Date(asOf).toISOString() };
  if (asOf < Date.parse(out.period.fromAt)) { out.newClients.reason = out.clients.reason = out.ltv.reason = 'PERIOD_NOT_OBSERVED'; return out; }
  const day = R.isoDay(asOf), seen = new Set();
  for (const row of snapshot.periods) {
    if (!row || !/^\d{4}-\d\d-\d\d$/.test(row.from) || !/^\d{4}-\d\d-\d\d$/.test(row.to) || row.from > row.to || row.to > R.isoDay(snapshot.observedThrough) || !validCount(row.newClients) || seen.has(row.from + '/' + row.to)) invalid();
    R.period({ mode: 'day', day: row.from }, now); R.period({ mode: 'day', day: row.to }, now); seen.add(row.from + '/' + row.to);
  }
  const selected = snapshot.periods.find(row => row.from === out.period.from && row.to === day);
  out.newClients.reason = 'PERIOD_AGGREGATE_UNAVAILABLE';
  if (selected) out.newClients = { value: selected.newClients, complete: true, reason: null, definition: 'Новые клиенты по определению YCLIENTS за выбранный период', seriesReason: out.period.mode === 'day' ? 'HOURLY_SERIES_UNAVAILABLE' : 'DAILY_SERIES_UNAVAILABLE' };
  if (out.period.mode === 'month') {
    out.newSeries = Array.from({ length: Number(out.period.to.slice(-2)) }, (_, i) => {
      const key = out.period.month + '-' + String(i + 1).padStart(2, '0');
      const nativeDay = snapshot.periods.find(row => row.from === key && row.to === key);
      return { key, value: key <= day && nativeDay ? nativeDay.newClients : null };
    });
  }
  const clients = snapshot.clients;
  if (clients) {
    if (!validCount(clients.total) || !Array.isArray(clients.groups) || clients.groups.length !== 6 || clients.groups.some((g, i) => g.key !== keys[i] || !validCount(g.count)) || clients.groups.reduce((n, g) => n + g.count, 0) !== clients.total || !/^\d{4}-\d\d-\d\d$/.test(clients.asOfDay) || clients.asOfDay !== R.isoDay(snapshot.observedThrough)) invalid();
    if (clients.asOfDay === day) {
      out.clients = { value: clients.total, complete: true, reason: null };
      out.groups = out.groups.map((g, i) => ({ ...g, count: clients.groups[i].count, percent: clients.total ? Math.round(clients.groups[i].count / clients.total * 1000) / 10 : 0 }));
    } else out.clients.reason = out.groupsReason = 'HISTORICAL_LAST_VISIT_UNAVAILABLE';
  }
  out.ltv.reason = 'CASH_HISTORY_INCOMPLETE';
  return out;
}
module.exports = { report, branches };
