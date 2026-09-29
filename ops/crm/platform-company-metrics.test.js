'use strict';
/* Фактические показатели компании 2ГИС: только загруженные отчёты, без внешних запросов.
   Все компании, организации, филиалы и числа здесь синтетические. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createPlatformDemand} = require('./platform-demand');
const {createPlatformCompanyMetrics, COMPANY_METRICS} = require('./platform-company-metrics');

const SCOPE_NOTE_TEXT = 'Данные без учёта данных сайтов партнёров';
const ORG = '70000000000000001', BRANCH = '70000000000000002', OTHER_BRANCH = '70000000000000003';
const CABINET = `https://account.2gis.com/orgs/${ORG}/stats`;

function fixture(t, {branch = BRANCH} = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name) VALUES(1,'demo-a','Компания А'),(2,'demo-b','Компания Б'),(3,'gone','Удалённая');
    UPDATE companies SET is_deleted=1 WHERE code='gone';`);
  const clock = {ms: Date.parse('2026-09-30T05:00:00Z')};
  const demand = createPlatformDemand(db, {now: () => clock.ms});
  const metrics = createPlatformCompanyMetrics(db, {now: () => clock.ms});
  const settings = (code, over = {}) => demand.saveSettings(code, {revision: demand.get(code).settings.revision,
    organizationId: ORG, organizationName: 'Демо', city: 'Демоград', cabinetUrl: CABINET, branchId: branch, ...over}, {userId: 1, userName: 'Влад'});
  settings('demo-a');
  return {db, demand, metrics, clock, settings};
}
const day = (index) => `2026-09-${String(index).padStart(2, '0')}`;
const rows = (metric, values, from = 1) => values.map((value, index) => ({date: day(from + index), metric, value,
  sourcePosition: metric === 'search_position' ? `B${index + 2}` : `A${index + 2}`}));
const report = (over = {}) => ({reportKind: 'appearance', periodStart: day(1), periodEnd: day(3), granularity: 'day',
  timezone: null, capturedDate: '2026-09-29', capturedAt: null, sourceKind: 'official_xlsx', sourceUrl: CABINET,
  originalFilename: 'appearance.xlsx', originalFileSha256: 'a'.repeat(64), scopeNote: null,
  rows: rows('appearance_views', [10, 0, 5]), ...over});
/* Импорт всегда идёт парой «предпросмотр → подтверждение»: подтверждение привязано к
   состоянию данных и к отпечатку именно показанного пакета. */
const pack = (f, list, over = {}, code = 'demo-a') => {
  const seen = f.metrics.preview(code, {reports: list}, {userId: 1, userName: 'Влад'});
  return f.metrics.importReports(code, {settingsRevision: f.demand.get(code).settings.revision,
    dataRevision: seen.dataRevision, packageHash: seen.packageHash, confirmReplace: false, reports: list, ...over},
    {userId: 1, userName: 'Влад'});
};

test('словарь ровно из одиннадцати показателей, позиция выдачи — отдельная семантика', (t) => {
  const f = fixture(t);
  const definitions = f.metrics.metricDefinitions();
  assert.equal(definitions.length, 11);
  assert.deepEqual([...new Set(definitions.map((item) => item.reportKind))].sort(), ['appearance', 'connections', 'pagevisits']);
  assert.equal(definitions.filter((item) => item.reportKind === 'connections').length, 7);
  const position = definitions.find((item) => item.metric === 'search_position');
  assert.equal(position.aggregation, 'daily_only');
  assert.equal(definitions.filter((item) => item.aggregation === 'sum').length, 10);
  assert.equal(Object.keys(COMPANY_METRICS).length, 11);
});

test('ноль и «нет данных» различаются, счётчики складываются, позиция выдачи — нет', (t) => {
  const f = fixture(t);
  pack(f, [report({rows: [...rows('appearance_views', [10, 0, null]), ...rows('search_position', [3, 12, 7])]})]);
  const result = f.metrics.summary('demo-a', day(1), day(3));
  const views = result.metrics.find((item) => item.metric === 'appearance_views');
  assert.equal(views.total, 10, 'ноль складывается как ноль, пустое значение в сумму не входит');
  assert.equal(views.daysWithValue, 2);assert.equal(views.daysWithoutValue, 1);assert.equal(views.zeroDays, 1);
  assert.equal(views.days.find((item) => item.date === day(2)).value, 0);
  assert.equal(views.days.find((item) => item.date === day(2)).hasValue, true);
  assert.equal(views.days.find((item) => item.date === day(3)).value, null);
  assert.equal(views.days.find((item) => item.date === day(3)).hasValue, false);
  const position = result.metrics.find((item) => item.metric === 'search_position');
  assert.equal(position.total, null, 'позиция не суммируется');
  assert.equal(position.totalAvailable, false);
  assert.match(position.totalNote, /не суммируется и не усредняется/);
  assert.equal(position.min, 3);assert.equal(position.max, 12);
  assert.equal(position.days.length, 3);
});

test('отчёт проверяется целиком: чужой показатель, отрицательный счётчик, нулевая позиция и дата вне периода не принимаются', (t) => {
  const f = fixture(t);
  const bad = [
    ['показатель другого отчёта', {rows: rows('page_visits', [5])}],
    ['неизвестный показатель', {rows: [{date: day(1), metric: 'clicks', value: 1}]}],
    ['отрицательный счётчик', {rows: rows('appearance_views', [-1])}],
    ['дробный счётчик', {rows: rows('appearance_views', [1.5])}],
    ['позиция ноль', {rows: rows('search_position', [0])}],
    ['дата вне периода', {rows: [{date: day(9), metric: 'appearance_views', value: 1}]}],
    ['дубль даты и показателя', {rows: [{date: day(1), metric: 'appearance_views', value: 1}, {date: day(1), metric: 'appearance_views', value: 2}]}],
    ['конец периода раньше начала', {periodStart: day(3), periodEnd: day(1)}],
    ['не дневная детализация', {granularity: 'week'}],
    ['неизвестный вид отчёта', {reportKind: 'reviews'}],
    ['неизвестный вид источника', {sourceKind: 'api'}],
    ['ограничение партнёров не у своего отчёта', {scopeNote: 'partner_sites_excluded'}],
    ['неизвестное ограничение', {reportKind: 'pagevisits', rows: rows('page_visits', [1]), scopeNote: 'whatever'}],
  ];
  for (const [name, over] of bad) assert.throws(() => pack(f, [report(over)]), (error) => error.status === 400, name);
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).coverage.valuesRead, 0, 'ни одна неверная попытка ничего не записала');
});

test('пакет атомарный: неверный второй отчёт отменяет и первый', (t) => {
  const f = fixture(t);
  assert.throws(() => pack(f, [report(), report({reportKind: 'pagevisits', rows: rows('appearance_views', [1])})]), (error) => error.status === 400);
  const result = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(result.coverage.reportsTotal, 0, 'частичного импорта не бывает');
  assert.equal(result.coverage.valuesRead, 0);
});

test('повтор тех же чисел и другой порядок строк не увеличивают итоги', (t) => {
  const f = fixture(t);
  const first = pack(f, [report()]);
  assert.equal(first.imported.length, 1);
  const same = pack(f, [report()]);
  assert.equal(same.imported.length, 0);assert.equal(same.skipped[0].reason, 'already_active');
  const shuffled = report({rows: [...rows('appearance_views', [10, 0, 5])].reverse()});
  const again = pack(f, [shuffled]);
  assert.equal(again.imported.length, 0, 'порядок строк не меняет смысл отчёта');
  const result = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(result.metrics.find((item) => item.metric === 'appearance_views').total, 15);
  assert.equal(result.coverage.reportsActive, 1);
});

test('перекрывающиеся снимки не складываются: правка требует подтверждения и сохраняет прежнюю версию', (t) => {
  const f = fixture(t);
  pack(f, [report()]);
  const corrected = report({rows: rows('appearance_views', [11, 0, 5]), originalFilename: 'appearance-v2.xlsx'});
  const preview = f.metrics.preview('demo-a', {reports: [corrected]});
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(preview.conflictCount, 3);
  assert.equal(preview.reports[0].changedValues, 1, 'видно, что именно меняется');
  const change = preview.reports[0].conflicts.find((item) => item.date === day(1));
  assert.equal(change.previousValue, 10);assert.equal(change.nextValue, 11);assert.equal(change.changed, true);
  assert.throws(() => pack(f, [corrected]), (error) => error.code === 'CONFIRMATION_REQUIRED' && error.status === 409);
  const accepted = pack(f, [corrected], {confirmReplace: true});
  assert.equal(accepted.imported[0].version, 2, 'версия — порядок принятого импорта');
  const result = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(result.metrics.find((item) => item.metric === 'appearance_views').total, 16, 'снимки не сложились');
  assert.equal(result.coverage.reportsActive, 1);
  assert.equal(result.coverage.reportsSuperseded, 1, 'прежняя версия сохранена, но не активна');
  assert.equal(result.history.length, 2);
  assert.match(accepted.note, /не время снятия/);
});

test('устаревшая ревизия настроек, чужая организация, чужой филиал и удалённая компания отклоняются', (t) => {
  const f = fixture(t);
  const seen = f.metrics.preview('demo-a', {reports: [report()]}, {userId: 1});
  assert.throws(() => f.metrics.importReports('demo-a', {settingsRevision: 99, dataRevision: seen.dataRevision,
    packageHash: seen.packageHash, confirmReplace: false, reports: [report()]}, {}),
    (error) => error.code === 'REVISION_CONFLICT' && error.status === 409);
  assert.throws(() => pack(f, [report({sourceUrl: 'https://account.2gis.com/orgs/70000000000000009/stats'})]),
    (error) => error.code === 'ORG_MISMATCH' && error.status === 409);
  assert.throws(() => pack(f, [report({sourceUrl: 'https://example.test/stats'})]),
    (error) => error.code === 'ORG_MISMATCH' && error.status === 409, 'чужой адрес источника');
  assert.throws(() => f.metrics.summary('demo-b', day(1), day(3)), (error) => error.code === 'CONFIGURATION_REQUIRED' && error.status === 409);
  assert.throws(() => f.metrics.summary('gone', day(1), day(3)), (error) => error.status === 404);
  assert.throws(() => f.metrics.summary('нет-такой', day(1), day(3)), (error) => error.status === 400);
  // Смена филиала — новая ревизия настроек: прежний импорт по старой ревизии больше не принимается.
  const before = f.demand.get('demo-a').settings.revision;
  f.settings('demo-a', {revision: before, branchId: OTHER_BRANCH});
  assert.throws(() => f.metrics.importReports('demo-a', {settingsRevision: before, dataRevision: 0,
    packageHash: 'b'.repeat(64), confirmReplace: false, reports: [report()]}, {}),
    (error) => error.code === 'REVISION_CONFLICT');
});

test('без подтверждённого филиала фактические показатели недоступны, спрос по рубрикам продолжает работать', (t) => {
  const f = fixture(t, {branch: ''});
  assert.throws(() => f.metrics.summary('demo-a', day(1), day(3)), (error) => error.code === 'CONFIGURATION_REQUIRED');
  const demand = f.demand.get('demo-a');
  assert.equal(demand.settings.configured, true, 'прежние настройки 2ГИС остаются рабочими');
  assert.equal(demand.settings.branchConfirmed, false);
  assert.equal(demand.settings.organizationId, ORG);
});

test('данные другой компании не попадают в сводку', (t) => {
  const f = fixture(t);
  f.demand.saveSettings('demo-b', {revision: 0, organizationId: ORG, organizationName: 'Демо', city: 'Демоград',
    cabinetUrl: CABINET, branchId: OTHER_BRANCH}, {userId: 1});
  pack(f, [report({rows: rows('appearance_views', [777])})], {}, 'demo-b');
  pack(f, [report()]);
  const mine = f.metrics.summary('demo-a', day(1), day(3));
  assert.doesNotMatch(JSON.stringify(mine), /777/, 'чужие числа не видны');
  assert.equal(mine.metrics.find((item) => item.metric === 'appearance_views').total, 15);
  const report_id = mine.reports[0].id;
  assert.throws(() => f.metrics.getReport('demo-b', report_id), (error) => error.status === 404, 'чужой отчёт по идентификатору не отдаётся');
});

test('метаданные источника сохраняются, исходный SHA256 отдельно от отпечатка содержимого и сервером не проверяется', (t) => {
  const f = fixture(t);
  const accepted = pack(f, [report({reportKind: 'pagevisits', rows: [...rows('page_visits', [3, 4, 5]), ...rows('page_actions', [6, 7, 8])],
    scopeNote: 'partner_sites_excluded', originalFilename: 'pagevisits.xlsx', originalFileSha256: 'b'.repeat(64)})]);
  const stored = f.metrics.getReport('demo-a', accepted.imported[0].reportId).report;
  assert.equal(stored.sourceKind, 'official_xlsx');
  assert.equal(stored.capturedDate, '2026-09-29');
  assert.equal(stored.capturedAt, null);assert.equal(stored.capturedAtKnown, false, 'время снятия Excel неизвестно и не выдумывается');
  assert.equal(stored.timezone, null);assert.equal(stored.timezoneKnown, false);
  assert.equal(stored.originalFileSha256, 'b'.repeat(64));
  assert.equal(stored.originalFileSha256Verified, false, 'байтов оригинала у сервера нет');
  assert.notEqual(stored.contentHash, stored.originalFileSha256);
  assert.match(stored.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(stored.scopeNoteLabel, 'Данные без учёта данных сайтов партнёров');
  assert.equal(stored.rows[0].sourcePosition, 'A2', 'точное место значения в источнике сохранено');
  assert.ok(stored.importedAt > stored.capturedDate, 'время импорта отдельно от времени снятия');
  const summary = f.metrics.summary('demo-a', day(1), day(3));
  const visits = summary.metrics.find((item) => item.metric === 'page_visits');
  assert.deepEqual(visits.scopeNotes, ['Данные без учёта данных сайтов партнёров']);
  const views = summary.metrics.find((item) => item.metric === 'appearance_views');
  assert.deepEqual(views.scopeNotes, [], 'ограничение не переносится на другие отчёты');
});

test('разные условия отчётов не сводятся в один итог, выводы говорят о покрытии и ограничениях', (t) => {
  const f = fixture(t);
  pack(f, [report({rows: rows('appearance_views', [10, 20])}),
    report({periodStart: day(4), periodEnd: day(5), timezone: 'Asia/Irkutsk', rows: rows('appearance_views', [30, 40], 4)})]);
  const result = f.metrics.summary('demo-a', day(1), day(5));
  const views = result.metrics.find((item) => item.metric === 'appearance_views');
  assert.equal(views.total, null, 'часовые пояса разные — общий итог не считается');
  assert.match(views.totalNote, /разных условиях/);
  assert.equal(views.daysWithValue, 4);
  assert.equal(result.coverage.expectedDays, 5);
  assert.equal(result.coverage.dates.length, 4);
  assert.ok(result.summary.cannotConclude.some((line) => /не за все дни/i.test(line)));
  assert.ok(result.summary.cannotConclude.some((line) => /не равны продажам/i.test(line)));
  assert.ok(result.summary.cannotConclude.some((line) => /не складываются между собой/i.test(line)));
  assert.ok(result.summary.cannotConclude.some((line) => /состоявшиеся звонки из него не выделяются/i.test(line)));
  assert.ok(result.summary.cannotConclude.some((line) => /Конверсия между отчётами не считается/i.test(line)));
  const empty = f.metrics.summary('demo-a', '2026-08-01', '2026-08-05');
  assert.equal(empty.coverage.valuesRead, 0);
  assert.ok(empty.summary.visible.some((line) => /Загруженных показателей за этот период нет/i.test(line)));
  assert.ok(empty.summary.cannotConclude.some((line) => /недостаточно/i.test(line)));
});

test('предпросмотр ничего не записывает и показывает состав пакета', (t) => {
  const f = fixture(t);
  const preview = f.metrics.preview('demo-a', {reports: [report({rows: rows('appearance_views', [10, 0, null])})]});
  assert.equal(preview.requiresConfirmation, false);
  assert.equal(preview.reports[0].rowCount, 3);
  assert.equal(preview.reports[0].knownValues, 2);
  assert.equal(preview.reports[0].zeroValues, 1);
  assert.deepEqual(preview.reports[0].dates, [day(1), day(2), day(3)]);
  assert.equal(preview.reports[0].alreadyImported, false);
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).coverage.reportsTotal, 0, 'предпросмотр не пишет');
  assert.throws(() => f.metrics.preview('demo-a', {reports: [report(), report()]}), (error) => error.status === 400,
    'один и тот же отчёт дважды в пакете не принимается');
});

/* Регрессии по возврату приёмки 29.09. Все числа и идентификаторы синтетические. */

test('частичное перекрытие заменяет только свой день: итог не удваивается', (t) => {
  const f = fixture(t);
  pack(f, [report({rows: rows('appearance_views', [10, 20, 30])})]);
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).metrics
    .find((item) => item.metric === 'appearance_views').total, 60);
  pack(f, [report({periodStart: day(2), periodEnd: day(2), rows: rows('appearance_views', [200], 2)})], {confirmReplace: true});
  const after = f.metrics.summary('demo-a', day(1), day(3));
  const views = after.metrics.find((item) => item.metric === 'appearance_views');
  assert.equal(views.total, 240, 'день 2 заменён, дни 1 и 3 сохранены');
  assert.equal(views.days.length, 3, 'на каждый день ровно одна принятая версия');
  assert.deepEqual(views.days.map((item) => item.value), [10, 200, 30]);
  assert.equal(after.coverage.reportsActive, 2, 'первый отчёт остался действующим на своих днях');
  assert.equal(after.history.length, 2, 'история не удаляется');
});

test('частичная замена одной метрики не уничтожает другие метрики того же дня', (t) => {
  const f = fixture(t);
  pack(f, [report({periodStart: day(1), periodEnd: day(1),
    rows: [{date: day(1), metric: 'appearance_views', value: 10, sourcePosition: 'A2'},
           {date: day(1), metric: 'search_position', value: 3, sourcePosition: 'B2'}]})]);
  pack(f, [report({periodStart: day(1), periodEnd: day(1),
    rows: [{date: day(1), metric: 'appearance_views', value: 11, sourcePosition: 'A2'}]})], {confirmReplace: true});
  const after = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(after.metrics.find((item) => item.metric === 'appearance_views').total, 11);
  const position = after.metrics.find((item) => item.metric === 'search_position');
  assert.equal(position.daysWithValue, 1, 'позиция выдачи пережила замену показов');
  assert.deepEqual(position.days.map((item) => item.value), [3]);
  assert.equal(after.coverage.reportsSuperseded, 0, 'отчёт с живыми значениями заменённым не считается');
  // Вторая частичная замена — теперь у первого отчёта не остаётся действующих значений.
  pack(f, [report({periodStart: day(1), periodEnd: day(1),
    rows: [{date: day(1), metric: 'search_position', value: 5, sourcePosition: 'B2'}]})], {confirmReplace: true});
  const last = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(last.coverage.reportsSuperseded, 1, 'полностью перекрытый отчёт помечен заменённым');
  assert.equal(last.metrics.find((item) => item.metric === 'search_position').days[0].value, 5);
  assert.equal(last.history.length, 3);
});

test('устаревший предпросмотр не записывается поверх невидимых изменений', (t) => {
  const f = fixture(t);
  pack(f, [report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [10])})]);
  const stale = f.metrics.preview('demo-a', {reports: [report({periodStart: day(1), periodEnd: day(1),
    rows: rows('appearance_views', [11])})]}, {userId: 1});
  // Между предпросмотром и подтверждением кто-то загрузил другое значение.
  pack(f, [report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [20])})], {confirmReplace: true});
  const revision = f.demand.get('demo-a').settings.revision;
  assert.throws(() => f.metrics.importReports('demo-a', {settingsRevision: revision, dataRevision: stale.dataRevision,
    packageHash: stale.packageHash, confirmReplace: true,
    reports: [report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [11])})]}, {userId: 1}),
    (error) => error.code === 'PREVIEW_STALE' && error.status === 409);
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).metrics
    .find((item) => item.metric === 'appearance_views').total, 20, '20 осталось, частичной записи не было');
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).history.length, 2, 'отказ ничего не создал');
  // Подменить состав пакета после предпросмотра тоже нельзя.
  const seen = f.metrics.preview('demo-a', {reports: [report({periodStart: day(2), periodEnd: day(2),
    rows: rows('appearance_views', [7], 2)})]}, {userId: 1});
  assert.throws(() => f.metrics.importReports('demo-a', {settingsRevision: revision, dataRevision: seen.dataRevision,
    packageHash: seen.packageHash, confirmReplace: true,
    reports: [report({periodStart: day(2), periodEnd: day(2), rows: rows('appearance_views', [999], 2)})]}, {userId: 1}),
    (error) => error.code === 'PREVIEW_STALE');
});

test('филиал: старый клиент его не теряет, пустая строка очищает, смена организации не переносит', (t) => {
  const f = fixture(t);
  const keep = f.demand.get('demo-a').settings.revision;
  // Запрос старого клиента без branchId для той же организации.
  f.demand.saveSettings('demo-a', {revision: keep, organizationId: ORG, organizationName: 'Демо',
    city: 'Демоград', cabinetUrl: CABINET}, {userId: 1});
  assert.equal(f.demand.get('demo-a').settings.branchId, BRANCH, 'настроенный филиал сохранён');
  // Явная пустая строка очищает.
  f.settings('demo-a', {revision: f.demand.get('demo-a').settings.revision, branchId: ''});
  assert.equal(f.demand.get('demo-a').settings.branchConfirmed, false);
  // Смена организации без branchId прежний филиал не переносит.
  f.settings('demo-a', {revision: f.demand.get('demo-a').settings.revision, branchId: BRANCH});
  const other = '70000000000000777';
  f.demand.saveSettings('demo-a', {revision: f.demand.get('demo-a').settings.revision, organizationId: other,
    organizationName: 'Другая', city: 'Демоград', cabinetUrl: `https://account.2gis.com/orgs/${other}/stats`}, {userId: 1});
  assert.equal(f.demand.get('demo-a').settings.branchId, '', 'филиал чужой организации не наследуется');
});

test('условия сбора не смешиваются, а выдуманная зона не считается известной', (t) => {
  const f = fixture(t);
  assert.throws(() => pack(f, [report({timezone: 'Mars/Olympus'})]), (error) => error.code === 'VALIDATION_ERROR');
  pack(f, [report({reportKind: 'pagevisits', periodStart: day(1), periodEnd: day(1), scopeNote: 'partner_sites_excluded',
    rows: [{date: day(1), metric: 'page_visits', value: 5, sourcePosition: 'A2'}]}),
    report({reportKind: 'pagevisits', periodStart: day(2), periodEnd: day(2), scopeNote: null,
      rows: [{date: day(2), metric: 'page_visits', value: 7, sourcePosition: 'A2'}]})]);
  const mixed = f.metrics.summary('demo-a', day(1), day(3)).metrics.find((item) => item.metric === 'page_visits');
  assert.equal(mixed.totalAvailable, false, 'отчёт с ограничением охвата и отчёт без него не складываются');
  assert.equal(mixed.mixedConditions, true);
  assert.match(mixed.totalNote, /разных условиях/);
  const f2 = fixture(t);
  pack(f2, [report({timezone: 'Asia/Irkutsk'})]);
  assert.equal(f2.metrics.summary('demo-a', day(1), day(3)).coverage.timezoneKnown, true);
});

test('известные значения и дни с измерениями — разные числа; пустые дни не выдаются за измеренные', (t) => {
  const f = fixture(t);
  pack(f, [report({periodStart: day(1), periodEnd: day(2),
    rows: [{date: day(1), metric: 'appearance_views', value: 10, sourcePosition: 'A2'},
           {date: day(1), metric: 'search_position', value: 3, sourcePosition: 'B2'},
           {date: day(2), metric: 'appearance_views', value: null, sourcePosition: 'A3'}]})]);
  const result = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(result.coverage.knownValues, 2, 'известных значений два');
  assert.deepEqual(result.coverage.datesWithValue, [day(1)], 'день без значения измеренным не считается');
  assert.ok(result.summary.visible.some((line) => /известных значений: 2/.test(line)));
  assert.ok(result.summary.visible.some((line) => /Дней с измерениями: 1 из 3/.test(line)));
  assert.ok(result.summary.nextStep.some((line) => /догрузить/.test(line)), 'пропуски есть — догрузка предлагается');
  const full = fixture(t);
  pack(full, [report({rows: rows('appearance_views', [1, 0, 2])})]);
  const complete = full.metrics.summary('demo-a', day(1), day(3));
  assert.deepEqual(complete.coverage.datesWithValue.length, 3);
  assert.equal(complete.coverage.zeroValues, 1, 'измеренный ноль остаётся значением');
  assert.equal(complete.summary.nextStep.some((line) => /догрузить/.test(line)), false, 'пропусков нет — догрузка не предлагается');
});

test('чужой филиал в ссылке не принимается, а пересечение внутри пакета отклоняется целиком', (t) => {
  const f = fixture(t);
  assert.throws(() => pack(f, [report({sourceUrl: `https://account.2gis.com/orgs/${ORG}/branches/${OTHER_BRANCH}/stats`})]),
    (error) => error.code === 'ORG_MISMATCH' && error.status === 409, 'ссылка на другой филиал той же организации');
  // Ссылка уровня организации остаётся допустимой: филиал из неё не выводится.
  pack(f, [report({sourceUrl: `https://account.2gis.com/orgs/${ORG}/statistics/`})]);
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).branchId, BRANCH);
  // Два отчёта одного вида об одном date+metric — скрытая замена внутри пакета.
  assert.throws(() => f.metrics.preview('demo-a', {reports: [
    report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [1])}),
    report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [2])})]}, {userId: 1}),
    (error) => error.code === 'VALIDATION_ERROR');
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).history.length, 1, 'отклонённый пакет ничего не записал');
});

/* Заключительная поправка приёмки 29.09: восстановление ранее заменённых чисел. */

test('A→B→A: подтверждённое восстановление принимается, история не переписывается', (t) => {
  const f = fixture(t);
  const A = () => report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [10])});
  const B = () => report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [20])});
  pack(f, [A()]);
  pack(f, [B()], {confirmReplace: true});
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).metrics
    .find((item) => item.metric === 'appearance_views').total, 20);
  const seen = f.metrics.preview('demo-a', {reports: [A()]}, {userId: 1});
  assert.equal(seen.requiresConfirmation, true);
  assert.equal(seen.reports[0].alreadyImported, false, 'это корректировка, а не «уже загружено»');
  assert.equal(seen.reports[0].restoresPreviousValues, true);
  assert.deepEqual(seen.reports[0].conflicts.map((item) => [item.previousValue, item.nextValue]), [[20, 10]]);
  const back = pack(f, [A()], {confirmReplace: true});
  assert.equal(back.imported.length, 1, 'показанная в предпросмотре корректировка не отменяется поиском дубля');
  assert.equal(back.skipped.length, 0);
  const after = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(after.metrics.find((item) => item.metric === 'appearance_views').total, 10);
  assert.equal(after.history.length, 3, 'прежние версии остались как были');
  assert.deepEqual(after.history.map((item) => item.version).sort(), [1, 2, 3]);
  assert.equal(after.dataRevision, 3, 'принятие увеличило dataRevision');
  // Повтор только что восстановленного A уже ничего не меняет.
  const repeat = pack(f, [A()], {confirmReplace: true});
  assert.equal(repeat.imported.length, 0);
  assert.equal(repeat.skipped[0].reason, 'already_active');
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).history.length, 3, 'повтор не создал версию');
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).dataRevision, 3);
});

test('частично перекрытый набор восстанавливается целиком, а не считается повтором', (t) => {
  const f = fixture(t);
  const A = () => report({rows: rows('appearance_views', [10, 20, 30])});
  pack(f, [A()]);
  // Заменён только день 2 — часть значений A ещё действует.
  pack(f, [report({periodStart: day(2), periodEnd: day(2), rows: rows('appearance_views', [200], 2)})], {confirmReplace: true});
  const seen = f.metrics.preview('demo-a', {reports: [A()]}, {userId: 1});
  assert.equal(seen.reports[0].alreadyImported, false, 'частично заменённый набор повтором не считается');
  assert.equal(seen.reports[0].changedValues, 1, 'изменится только день 2');
  const back = pack(f, [A()], {confirmReplace: true});
  assert.equal(back.imported.length, 1);
  const after = f.metrics.summary('demo-a', day(1), day(3));
  assert.deepEqual(after.metrics.find((item) => item.metric === 'appearance_views').days.map((item) => item.value), [10, 20, 30]);
  assert.equal(after.metrics.find((item) => item.metric === 'appearance_views').total, 60);
  assert.equal(after.history.length, 3);
  assert.equal(after.coverage.reportsSuperseded, 2, 'обе прежние версии полностью перекрыты');
});

test('защита от устаревшего предпросмотра работает и после восстановления', (t) => {
  const f = fixture(t);
  const A = () => report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [10])});
  const B = () => report({periodStart: day(1), periodEnd: day(1), rows: rows('appearance_views', [20])});
  pack(f, [A()]);
  pack(f, [B()], {confirmReplace: true});
  const stale = f.metrics.preview('demo-a', {reports: [A()]}, {userId: 1});
  // Пока владелец думал, кто-то восстановил A сам.
  pack(f, [A()], {confirmReplace: true});
  assert.throws(() => f.metrics.importReports('demo-a', {settingsRevision: f.demand.get('demo-a').settings.revision,
    dataRevision: stale.dataRevision, packageHash: stale.packageHash, confirmReplace: true, reports: [A()]}, {userId: 1}),
    (error) => error.code === 'PREVIEW_STALE' && error.status === 409);
  assert.equal(f.metrics.summary('demo-a', day(1), day(3)).history.length, 3, 'отказ ничего не создал');
});

test('база от недоставленного прототипа не запускается молча', (t) => {
  const f = fixture(t);
  const legacy = new DatabaseSync(':memory:'); t.after(() => legacy.close());
  legacy.exec(`CREATE TABLE platform_company_metric_values (
    report_id INTEGER NOT NULL, company_code TEXT NOT NULL, organization_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    report_kind TEXT NOT NULL, date TEXT NOT NULL, metric TEXT NOT NULL, value REAL,
    source_label TEXT NOT NULL DEFAULT '', source_position TEXT NOT NULL DEFAULT '', PRIMARY KEY(report_id,date,metric));`);
  assert.throws(() => createPlatformCompanyMetrics(legacy), (error) => error.code === 'SCHEMA_INCOMPATIBLE');
  assert.ok(f.metrics.metricDefinitions().length === 11, 'чистая база работает как прежде');
});

/* Поправка сравнения повторов 29.09: одинаковые числа при других условиях сбора
   или другом подтверждении источника повтором не считаются. */

test('те же числа при смене часового пояса и охвата источника — не повтор', (t) => {
  const f = fixture(t);
  const base = (over = {}) => report({reportKind: 'pagevisits', periodStart: day(1), periodEnd: day(1),
    rows: [{date: day(1), metric: 'page_visits', value: 5, sourcePosition: 'A2'}], ...over});
  pack(f, [base()]);
  const fixed = base({timezone: 'Asia/Irkutsk', scopeNote: 'partner_sites_excluded'});
  const seen = f.metrics.preview('demo-a', {reports: [fixed]}, {userId: 1});
  assert.equal(seen.reports[0].alreadyImported, false, 'исправление сопоставимости не считается повтором');
  assert.equal(seen.reports[0].changedValues, 0, 'числа те же');
  assert.equal(seen.reports[0].unchangedValuesWithNewConditions, 1);
  assert.equal(seen.conditionsOnly, true);
  assert.deepEqual(seen.reports[0].conditionChanges.map((item) => item.field).sort(), ['scopeNote', 'timezone']);
  assert.match(seen.note, /изменились условия сбора/);
  const accepted = pack(f, [fixed], {confirmReplace: true});
  assert.equal(accepted.imported.length, 1, 'новая версия сохранена');
  const after = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(after.coverage.timezoneKnown, true, 'часовой пояс теперь известен');
  assert.equal(after.metrics.find((item) => item.metric === 'page_visits')
    .scopeNotes.includes(SCOPE_NOTE_TEXT), true, 'ограничение охвата сохранено');
  assert.equal(after.history.length, 2, 'прежняя версия осталась в истории');
  assert.equal(after.metrics.find((item) => item.metric === 'page_visits').total, 5, 'двойного счёта нет');
});

test('подтверждение официальным источником с SHA256 не теряется', (t) => {
  const f = fixture(t);
  const rowsOne = [{date: day(1), metric: 'appearance_views', value: 10, sourcePosition: 'A2'}];
  pack(f, [report({periodStart: day(1), periodEnd: day(1), sourceKind: 'visible_table',
    originalFilename: null, originalFileSha256: null, rows: rowsOne})]);
  const official = report({periodStart: day(1), periodEnd: day(1), sourceKind: 'official_xlsx',
    originalFilename: 'appearance.xlsx', originalFileSha256: 'c'.repeat(64), rows: rowsOne});
  const seen = f.metrics.preview('demo-a', {reports: [official]}, {userId: 1});
  assert.equal(seen.reports[0].alreadyImported, false);
  assert.deepEqual(seen.reports[0].conditionChanges.map((item) => item.field).sort(), ['originalFileSha256', 'sourceKind']);
  pack(f, [official], {confirmReplace: true});
  const after = f.metrics.summary('demo-a', day(1), day(3));
  const current = after.reports.find((item) => item.sourceKind === 'official_xlsx');
  assert.ok(current, 'официальный источник стал действующим');
  assert.equal(current.originalFileSha256, 'c'.repeat(64));
  assert.equal(current.originalFileSha256Verified, false, 'сервер чужой отпечаток по-прежнему не проверяет');
  assert.equal(after.metrics.find((item) => item.metric === 'appearance_views').total, 10);
  assert.equal(after.history.length, 2);
});

test('полностью одинаковый повтор, перестановка строк и переименование файла новой версии не создают', (t) => {
  const f = fixture(t);
  pack(f, [report()]);
  const same = pack(f, [report()], {confirmReplace: true});
  assert.equal(same.imported.length, 0);
  assert.equal(same.skipped[0].reason, 'already_active');
  const shuffled = pack(f, [report({rows: [...rows('appearance_views', [10, 0, 5])].reverse()})], {confirmReplace: true});
  assert.equal(shuffled.imported.length, 0, 'порядок строк условий не меняет');
  const renamed = pack(f, [report({originalFilename: 'appearance (1).xlsx'})], {confirmReplace: true});
  assert.equal(renamed.imported.length, 0, 'переименование того же файла — не новое наблюдение');
  const after = f.metrics.summary('demo-a', day(1), day(3));
  assert.equal(after.history.length, 1);
  assert.equal(after.dataRevision, 1);
  assert.equal(after.metrics.find((item) => item.metric === 'appearance_views').total, 15, 'двойного счёта нет');
});

test('подтверждение связывает весь источник: его нельзя заменить после предпросмотра при тех же числах', (t) => {
  const f = fixture(t);
  const original = report();
  const seen = f.metrics.preview('demo-a', {reports: [original]});
  for (const changed of [
    {...original, sourceKind: 'visible_table'},
    {...original, originalFileSha256: 'b'.repeat(64)},
    {...original, capturedDate: '2026-09-30'},
    {...original, originalFilename: 'another.xlsx'},
  ]) {
    assert.throws(() => f.metrics.importReports('demo-a', {
      settingsRevision: seen.settingsRevision, dataRevision: seen.dataRevision,
      packageHash: seen.packageHash, confirmReplace: true, reports: [changed],
    }), {code: 'PREVIEW_STALE'});
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM platform_company_metric_reports').get().n, 0);
});
