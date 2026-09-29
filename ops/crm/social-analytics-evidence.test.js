'use strict';
/* Доказательства аналитики. Данные синтетические, сети нет. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialAnalyticsEvidence} = require('./social-analytics-evidence');

const base = (over = {}) => ({
  companyCode: 'alvi', provider: 'onlypult_analytics', providerRef: 'an_demo1', platform: 'instagram',
  nativeAccountId: '17841400000000001', runId: 'run-1', kind: 'collector',
  endpoint: 'overview', chart: 'FollowersCountChart', metricKey: 'followers_count', synapseMetric: 'followers',
  source: 'network', unit: 'count', scope: 'profile', periodFrom: '2026-09-20', periodTo: '2026-09-22',
  granularity: 'day', timezone: 'Asia/Irkutsk', catalogVersion: 'instagram:17m:59c', mappingVersion: '2026-09-29',
  coverage: {coveredFrom: '2026-09-21', collecting: true, collectionEnabled: true}, warnings: ['данные догружаются'],
  points: [{date: '2026-09-21', value: 136}, {date: '2026-09-22', value: 0}],
  summary: 136, completeness: 'partial', structureConfirmed: true, collectedAt: '2026-09-29T10:00:00Z', ...over});

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  return {db, api: createSocialAnalyticsEvidence(db, {now: () => Date.parse('2026-09-29T11:00:00Z')})};
}

test('доказательство добавляется целиком и сохраняет происхождение, покрытие и предупреждения', (t) => {
  const f = fixture(t);
  const {evidence, created} = f.api.record(base());
  assert.equal(created, true);
  assert.equal(evidence.providerRef, 'an_demo1');
  assert.equal(evidence.nativeAccountId, '17841400000000001');
  assert.equal(evidence.chart, 'FollowersCountChart');
  assert.equal(evidence.synapseMetric, 'followers');
  assert.deepEqual(evidence.period, {from: '2026-09-20', to: '2026-09-22', granularity: 'day', timezone: 'Asia/Irkutsk'});
  assert.deepEqual(evidence.coverage, {coveredFrom: '2026-09-21', coveredTo: null, collecting: true, collectionEnabled: true, known: null});
  assert.deepEqual(evidence.warnings, ['данные догружаются']);
  assert.equal(evidence.completeness, 'partial');
  assert.equal(evidence.structureConfirmed, true);
  // Журнал добавляемый: модуль не предоставляет ни изменения, ни удаления.
  assert.equal(typeof f.api.record, 'function');
  assert.equal(f.api.update, undefined);
  assert.equal(f.api.remove, undefined);
});

test('настоящий ноль сохраняется как измерение, а отсутствие значения — как null с причиной', (t) => {
  const f = fixture(t);
  const {evidence} = f.api.record(base({points: [
    {date: '2026-09-21', value: 0},
    {date: '2026-09-22', value: null},
    {date: '2026-09-23', value: null, reason: 'дата вне подтверждённого покрытия'},
  ], summary: null}));
  assert.equal(evidence.points[0].value, 0);
  assert.equal(evidence.points[0].reason, undefined, 'у измеренного нуля причины нет');
  assert.equal(evidence.points[1].value, null);
  assert.match(evidence.points[1].reason, /не вернул значение/);
  assert.equal(evidence.points[2].reason, 'дата вне подтверждённого покрытия');
  assert.equal(evidence.summary, null);
  assert.match(evidence.summaryReason, /не вернул итог/, 'у отсутствующего итога обязана быть причина');
});

test('секреты и чужие поля в доказательство не попадают', (t) => {
  const f = fixture(t);
  for (const bad of [{authorization: 'Bearer TEST_ONLY'}, {credential: 'TEST_ONLY'}, {url: 'https://api.onlypult.com/v1?key=TEST_ONLY'},
    {postText: 'текст публикации'}, {contact: 'email@example.test'}]) {
    assert.throws(() => f.api.record(base(bad)), (error) => error.status === 400, Object.keys(bad)[0] + ' отклонено');
  }
  assert.throws(() => f.api.record(base({source: 'network_guess'})), (error) => error.status === 400);
  assert.throws(() => f.api.record(base({completeness: 'final'})), (error) => error.status === 400);
  assert.throws(() => f.api.record(base({timezone: 'Mars/Olympus'})), (error) => error.status === 400);
  assert.throws(() => f.api.record(base({periodFrom: '2026-09-25', periodTo: '2026-09-20'})), (error) => error.status === 400);
  assert.equal(f.api.list({companyCode: 'alvi'}).length, 0, 'ни одна отклонённая запись не сохранилась');
});

test('перенос прежних измерений идемпотентен и сохраняет 136 и настоящий ноль', (t) => {
  const f = fixture(t);
  const telegram = {companyCode: 'alvi', provider: 'manual', platform: 'telegram', nativeAccountId: '@spa_stio_alvi',
    runId: 'legacy-migration', kind: 'legacy', legacyRef: 'social_snapshots:1', source: 'unknown',
    synapseMetric: 'followers', scope: 'profile', unit: 'count', granularity: 'lifetime',
    periodFrom: '2026-09-29', periodTo: '2026-09-29', notes: 'Telegram Web channel header subscribers',
    points: [{date: '2026-09-29', value: 136}], summary: 136, completeness: 'unknown',
    collectedAt: '2026-09-29T08:58:00Z'};
  const youtube = {...telegram, platform: 'youtube', nativeAccountId: 'UCwkOrlmN-iSRdlYN35Qiu5w',
    legacyRef: 'social_snapshots:2', notes: 'YouTube Studio subscribers',
    points: [{date: '2026-09-29', value: 0}], summary: 0, collectedAt: '2026-09-29T09:23:00Z'};
  const first = f.api.recordRun([telegram, youtube]);
  assert.equal(first.recorded, 2);
  // Повтор миграции копий не создаёт и значения не меняет.
  const again = f.api.recordRun([telegram, youtube]);
  assert.equal(again.recorded, 0);
  assert.equal(again.reused, 2);
  const stored = f.api.list({companyCode: 'alvi'});
  assert.equal(stored.length, 2);
  const tg = stored.find((item) => item.platform === 'telegram');
  assert.equal(tg.points[0].value, 136);
  assert.equal(tg.collectedAt, '2026-09-29T08:58:00.000Z');
  assert.equal(tg.notes, 'Telegram Web channel header subscribers');
  const yt = stored.find((item) => item.platform === 'youtube');
  assert.equal(yt.points[0].value, 0, 'настоящий ноль сохранён как ноль');
  assert.equal(yt.points[0].reason, undefined);
  assert.equal(yt.nativeAccountId, 'UCwkOrlmN-iSRdlYN35Qiu5w');
  assert.equal(yt.kind, 'legacy');
});

test('пакет пишется целиком или не пишется вовсе; компании и аккаунты не смешиваются', (t) => {
  const f = fixture(t);
  assert.throws(() => f.api.recordRun([base(), base({source: 'выдумка'})]), (error) => error.status === 400);
  assert.equal(f.api.list({companyCode: 'alvi'}).length, 0, 'отказ отменил весь пакет');
  f.api.record(base());
  f.api.record(base({companyCode: 'avokado', providerRef: 'an_demo2', nativeAccountId: '17841400000000002'}));
  assert.equal(f.api.list({companyCode: 'alvi'}).length, 1);
  assert.equal(f.api.list({companyCode: 'alvi', nativeAccountId: '17841400000000002'}).length, 0);
  assert.equal(f.api.byRun('avokado', 'run-1').length, 1);
});

test('P2 вложенные поля покрытия, предупреждений и раздела не обходят ограничения доказательств', (t) => {
  const f = fixture(t);
  // Покрытие — строгая схема: произвольное поле внутрь не проезжает.
  assert.throws(() => f.api.record(base({coverage: {coveredFrom: '2026-09-21', authorization: 'Bearer TEST_ONLY_FAKE'}})),
    (error) => error.status === 400, 'чужое поле покрытия отклонено');
  assert.throws(() => f.api.record(base({coverage: {coveredFrom: '2026-09-21', collecting: 'да'}})), (error) => error.status === 400);
  assert.throws(() => f.api.record(base({coverage: [{coveredFrom: '2026-09-21'}]})), (error) => error.status === 400);
  // Предупреждения — только короткие строки без ссылок: ссылка может нести ключ в query.
  assert.throws(() => f.api.record(base({warnings: [{message: 'x', url: 'https://api.onlypult.com/v1/analytics?token=TEST_ONLY_FAKE'}]})),
    (error) => error.status === 400, 'объект-предупреждение отклонён');
  assert.throws(() => f.api.record(base({warnings: ['см. https://api.onlypult.com/v1?token=TEST_ONLY_FAKE']})),
    (error) => error.status === 400, 'предупреждение со ссылкой отклонено');
  // Раздел источника — фиксированное имя, а не URL со строкой запроса.
  assert.throws(() => f.api.record(base({endpoint: 'https://api.onlypult.com/v1/analytics/an_demo1/overview?token=TEST_ONLY_FAKE'})),
    (error) => error.status === 400, 'URL вместо имени раздела отклонён');
  assert.throws(() => f.api.record(base({endpoint: 'secret-dump'})), (error) => error.status === 400);
  // В базе не осталось ни одной из отклонённых записей и ни одного следа этих строк.
  assert.equal(f.api.list({companyCode: 'alvi'}).length, 0);
  const dump = JSON.stringify(f.db.prepare('SELECT * FROM social_analytics_evidence').all());
  for (const trace of ['TEST_ONLY_FAKE', 'authorization', 'token=']) assert.equal(dump.includes(trace), false, trace + ' не сохранён');
  // Допустимая запись проходит и приводит покрытие к строгой форме.
  const {evidence} = f.api.record(base({coverage: {coveredFrom: '2026-09-21', collectionEnabled: false}, warnings: ['данные догружаются'], endpoint: 'overview'}));
  assert.deepEqual(evidence.coverage, {coveredFrom: '2026-09-21', coveredTo: null, collecting: null, collectionEnabled: false, known: null});
  assert.deepEqual(evidence.warnings, ['данные догружаются']);
  assert.equal(evidence.endpoint, 'overview');
});
