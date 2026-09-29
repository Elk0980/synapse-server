'use strict';
/* Доказательства аналитики: добавляемый журнал того, что реально пришло от источника.

   Зачем отдельно от social_snapshots: snapshots — изменяемая ПРОЕКЦИЯ по уникальному ключу,
   повторный сбор её перезаписывает. Доказательство перезаписывать нельзя: иначе нечем
   ответить на вопрос «откуда взялось это число и что именно вернул источник в тот раз».
   Поэтому здесь только INSERT: ни UPDATE, ни DELETE модуль не предоставляет.

   Что сюда НЕ попадает ни при каких условиях: ключи и заголовок Authorization, URL с
   секретами в строке запроса, тексты и медиа публикаций, имена и контакты людей. Запись
   собирается из белого списка полей, всё остальное отбрасывается, а не «чистится». */

const KINDS = Object.freeze(['collector', 'legacy', 'manual']);
const SOURCES = Object.freeze(['network', 'derived', 'unknown']);
// Полнота дня. unknown — покрытие источником не подтверждено; partial — день не закрыт
// или источник предупредил о догрузке; complete — закрытые сутки без предупреждений.
const COMPLETENESS = Object.freeze(['complete', 'partial', 'unknown']);

/* Раздел источника называется фиксированным именем из этого списка, а не произвольной
   строкой: иначе в endpoint приезжал полный URL с ключом в строке запроса. */
const ENDPOINT_NAMES = Object.freeze(['profiles', 'metrics', 'overview', 'audience', 'posts', 'profile-metrics', 'chart', 'manual', 'legacy']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status, code: 'VALIDATION_ERROR'}); };
const text = (value, max, required = false) => {
  if (value === null || value === undefined) { if (required) fail('Обязательное поле происхождения не заполнено'); return ''; }
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('Недопустимое поле происхождения');
  const out = value.trim();
  if (required && !out) fail('Обязательное поле происхождения не заполнено');
  return out;
};
const day = (value, required = true) => {
  if (value === null || value === undefined || value === '') { if (required) fail('Нужна дата в формате ГГГГ-ММ-ДД'); return null; }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Нужна дата в формате ГГГГ-ММ-ДД');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('Нужна существующая дата');
  return value;
};
const instant = (value, required = true) => {
  if (value === null || value === undefined || value === '') { if (required) fail('Нужно время получения ответа'); return null; }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail('Время указывается в UTC');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('Время указывается в UTC');
  return parsed.toISOString();
};
/* Часовой пояс проверяется настоящим списком IANA, а не формой строки: выдуманная зона
   не должна попасть в доказательство и потом объяснять «в каком дне» снято значение. */
const zone = (value, required = false) => {
  if (value === null || value === undefined || value === '') { if (required) fail('Нужен часовой пояс источника'); return null; }
  const raw = text(value, 64, true);
  try { new Intl.DateTimeFormat('en-US', {timeZone: raw}); } catch { fail('Неизвестный часовой пояс источника'); }
  return raw;
};
const number = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('Значение должно быть числом или отсутствовать');
  return value;
};
/* Покрытие — строгая схема, а не «любой объект источника». Раньше произвольный объект
   уезжал в базу целиком, и вместе с ним сохранялись, например, поля вида authorization. */
const COVERAGE_FIELDS = Object.freeze(['coveredFrom', 'coveredTo', 'collecting', 'collectionEnabled', 'known']);
function coverageOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Покрытие передаётся объектом');
  const unknown = Object.keys(value).filter((key) => !COVERAGE_FIELDS.includes(key));
  if (unknown.length) fail(`Недопустимое поле покрытия «${unknown[0]}»`);
  const flag = (item) => {
    if (item === undefined || item === null) return null;
    if (typeof item !== 'boolean') fail('Признак покрытия — true, false или отсутствует');
    return item;
  };
  return {coveredFrom: day(value.coveredFrom, false), coveredTo: day(value.coveredTo, false),
    collecting: flag(value.collecting), collectionEnabled: flag(value.collectionEnabled), known: flag(value.known)};
}
/* Предупреждения — только короткие строки. Объект с вложенными URL и подписями сюда не
   проходит; текст обрезается и очищается от управляющих символов. */
function warningsOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) fail('Предупреждения передаются массивом не длиннее 20 строк');
  return value.map((item) => {
    if (typeof item !== 'string') fail('Предупреждение передаётся строкой');
    const out = item.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!out) fail('Пустое предупреждение не сохраняется');
    // Ссылка внутри предупреждения может нести ключ в строке запроса: такой текст не сохраняем.
    if (/https?:\/\//i.test(out)) fail('Предупреждение со ссылкой не сохраняется: ссылка может нести ключ');
    return out;
  });
}
const jsonOf = (value, max = 20000) => {
  const out = JSON.stringify(value ?? null);
  if (out.length > max) fail('Слишком большой блок доказательства');
  return out;
};

/* Точки ряда. Здесь решается главное различие всей задачи:
   значение есть (в том числе настоящий 0) — пишется как есть;
   значения нет (null, поле отсутствует, пустой массив) — пишется null И причина.
   Превращать отсутствие в 0 запрещено: «не измеряли» и «измерили ноль» — разные факты. */
const points = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1000) fail('Ряд значений должен быть массивом не длиннее 1000 точек');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Точка ряда должна быть объектом');
    const keys = Object.keys(item).filter((key) => !['date', 'value', 'reason'].includes(key));
    if (keys.length) fail(`Неизвестное поле точки «${keys[0]}»`);
    const out = {date: day(item.date), value: number(item.value)};
    const reason = text(item.reason, 200);
    if (out.value === null) out.reason = reason || 'источник не вернул значение за эту дату';
    else if (reason) out.reason = reason;
    return out;
  });
};

function createSocialAnalyticsEvidence(db, {now = () => Date.now()} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS social_analytics_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL COLLATE NOCASE, provider TEXT NOT NULL, provider_ref TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL, native_account_id TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL,
    kind TEXT NOT NULL, endpoint TEXT NOT NULL DEFAULT '', chart TEXT NOT NULL DEFAULT '',
    metric_key TEXT NOT NULL DEFAULT '', synapse_metric TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'unknown', formula TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
    period_from TEXT, period_to TEXT, granularity TEXT NOT NULL DEFAULT '', timezone TEXT,
    catalog_version TEXT NOT NULL DEFAULT '', mapping_version TEXT NOT NULL DEFAULT '',
    coverage_json TEXT NOT NULL DEFAULT 'null', warnings_json TEXT NOT NULL DEFAULT '[]',
    points_json TEXT NOT NULL DEFAULT '[]', summary_value REAL, summary_reason TEXT NOT NULL DEFAULT '',
    completeness TEXT NOT NULL DEFAULT 'unknown', structure_confirmed INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '', legacy_ref TEXT NOT NULL DEFAULT '',
    collected_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS social_analytics_evidence_scope
      ON social_analytics_evidence(company_code, platform, native_account_id, period_from);
    CREATE INDEX IF NOT EXISTS social_analytics_evidence_run
      ON social_analytics_evidence(company_code, run_id);
    /* Повторная миграция прежних измерений не должна плодить копии: одно доказательство
       на одну исходную строку. Для сборов ключ пустой и уникальность не действует. */
    CREATE UNIQUE INDEX IF NOT EXISTS social_analytics_evidence_legacy
      ON social_analytics_evidence(company_code, legacy_ref) WHERE legacy_ref<>'';`);

  const stamp = () => new Date(now()).toISOString();

  const dto = (row) => ({
    id: row.id, companyCode: row.company_code, provider: row.provider, providerRef: row.provider_ref || null,
    platform: row.platform, nativeAccountId: row.native_account_id || null, runId: row.run_id, kind: row.kind,
    endpoint: row.endpoint || null, chart: row.chart || null, metricKey: row.metric_key || null,
    synapseMetric: row.synapse_metric || null, source: row.source, formula: row.formula || null,
    notes: row.notes || null, unit: row.unit || null, scope: row.scope || null,
    period: {from: row.period_from, to: row.period_to, granularity: row.granularity || null, timezone: row.timezone || null},
    catalogVersion: row.catalog_version || null, mappingVersion: row.mapping_version || null,
    coverage: JSON.parse(row.coverage_json), warnings: JSON.parse(row.warnings_json),
    points: JSON.parse(row.points_json),
    summary: row.summary_value === null || row.summary_value === undefined ? null : row.summary_value,
    summaryReason: row.summary_reason || null, completeness: row.completeness,
    // Структура ответа подтверждена контрактом (overview/audience/chart) или нет (posts/profile-metrics).
    structureConfirmed: Boolean(row.structure_confirmed),
    reason: row.reason || null, legacyRef: row.legacy_ref || null,
    collectedAt: row.collected_at, createdAt: row.created_at,
  });

  const ALLOWED = ['companyCode', 'provider', 'providerRef', 'platform', 'nativeAccountId', 'runId', 'kind',
    'endpoint', 'chart', 'metricKey', 'synapseMetric', 'source', 'formula', 'notes', 'unit', 'scope',
    'periodFrom', 'periodTo', 'granularity', 'timezone', 'catalogVersion', 'mappingVersion',
    'coverage', 'warnings', 'points', 'summary', 'summaryReason', 'completeness', 'structureConfirmed',
    'reason', 'legacyRef', 'collectedAt'];

  /* Запись доказательства. Только белый список полей: любое незнакомое поле — отказ,
     а не молчаливое сохранение. Так секрет не может попасть сюда «за компанию». */
  function record(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Доказательство должно быть объектом');
    const unknown = Object.keys(entry).filter((key) => !ALLOWED.includes(key));
    if (unknown.length) fail(`Недопустимое поле доказательства «${unknown[0]}»`);
    const kind = entry.kind;
    if (!KINDS.includes(kind)) fail('Неизвестный вид доказательства');
    const source = entry.source === undefined || entry.source === null ? 'unknown' : entry.source;
    if (!SOURCES.includes(source)) fail('Источник значения: network, derived или unknown');
    const completeness = entry.completeness === undefined || entry.completeness === null ? 'unknown' : entry.completeness;
    if (!COMPLETENESS.includes(completeness)) fail('Полнота: complete, partial или unknown');
    const coverage = coverageOf(entry.coverage), warnings = warningsOf(entry.warnings);
    const endpoint = entry.endpoint === undefined || entry.endpoint === null || entry.endpoint === '' ? '' : text(entry.endpoint, 40, true);
    if (endpoint && !ENDPOINT_NAMES.includes(endpoint)) fail(`Неизвестный раздел источника «${endpoint}»`);
    const from = day(entry.periodFrom, false), to = day(entry.periodTo, false);
    if (from && to && from > to) fail('Начало периода позже конца');
    const summary = number(entry.summary);
    const list = points(entry.points);
    const row = {
      company_code: text(entry.companyCode, 64, true).toLowerCase(),
      provider: text(entry.provider, 64, true),
      provider_ref: text(entry.providerRef, 120),
      platform: text(entry.platform, 40, true),
      native_account_id: text(entry.nativeAccountId, 200),
      run_id: text(entry.runId, 80, true),
      kind, endpoint, chart: text(entry.chart, 120),
      metric_key: text(entry.metricKey, 80), synapse_metric: text(entry.synapseMetric, 80),
      source, formula: text(entry.formula, 300), notes: text(entry.notes, 500),
      unit: text(entry.unit, 40), scope: text(entry.scope, 60),
      period_from: from, period_to: to, granularity: text(entry.granularity, 20),
      timezone: zone(entry.timezone, false),
      catalog_version: text(entry.catalogVersion, 80), mapping_version: text(entry.mappingVersion, 40),
      coverage_json: jsonOf(coverage), warnings_json: jsonOf(warnings, 8000),
      points_json: jsonOf(list, 120000),
      summary_value: summary,
      // У отсутствующего итога обязана быть причина: «пусто» само по себе ничего не объясняет.
      summary_reason: summary === null ? (text(entry.summaryReason, 300) || 'источник не вернул итог за период') : text(entry.summaryReason, 300),
      completeness, structure_confirmed: entry.structureConfirmed === true ? 1 : 0,
      reason: text(entry.reason, 300), legacy_ref: text(entry.legacyRef, 200),
      collected_at: instant(entry.collectedAt, true), created_at: stamp(),
    };
    /* Перенос прежних измерений идемпотентен: повтор миграции возвращает уже созданное
       доказательство и ничего не дублирует. Сборы этим ключом не ограничены. */
    if (row.legacy_ref) {
      const existing = db.prepare('SELECT * FROM social_analytics_evidence WHERE company_code=? COLLATE NOCASE AND legacy_ref=?')
        .get(row.company_code, row.legacy_ref);
      if (existing) return {evidence: dto(existing), created: false};
    }
    const columns = Object.keys(row);
    const id = Number(db.prepare(`INSERT INTO social_analytics_evidence(${columns.join(',')})
      VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map((key) => row[key])).lastInsertRowid);
    return {evidence: dto(db.prepare('SELECT * FROM social_analytics_evidence WHERE id=?').get(id)), created: true};
  }

  /* Пакет доказательств одного запуска пишется целиком или не пишется вовсе.
     Если вызывающий уже открыл транзакцию (запись проекции и доказательства должны лечь
     вместе), своя не открывается: вложенная транзакция в SQLite невозможна, а разрывать
     общую атомарность нельзя. */
  const inTransaction = () => {
    try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); return false; } catch { return true; }
  };
  function recordRun(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 500) fail('Пакет доказательств пуст или слишком велик');
    const run = () => {
      const out = entries.map((item) => record(item));
      return {recorded: out.filter((item) => item.created).length, reused: out.filter((item) => !item.created).length,
        evidence: out.map((item) => item.evidence)};
    };
    if (inTransaction()) return run();
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function list({companyCode: code, platform, nativeAccountId, from, to, runId, limit = 200} = {}) {
    const where = ['company_code=? COLLATE NOCASE'], params = [text(code, 64, true).toLowerCase()];
    if (platform) { where.push('platform=?'); params.push(text(platform, 40, true)); }
    if (nativeAccountId) { where.push('native_account_id=?'); params.push(text(nativeAccountId, 200, true)); }
    if (runId) { where.push('run_id=?'); params.push(text(runId, 80, true)); }
    if (from) { where.push('(period_to IS NULL OR period_to>=?)'); params.push(day(from)); }
    if (to) { where.push('(period_from IS NULL OR period_from<=?)'); params.push(day(to)); }
    const cap = Number.isSafeInteger(limit) && limit > 0 && limit <= 1000 ? limit : 200;
    return db.prepare(`SELECT * FROM social_analytics_evidence WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT ${cap}`).all(...params).map(dto);
  }

  const byRun = (code, runId) => list({companyCode: code, runId, limit: 1000});

  return {record, recordRun, list, byRun};
}

module.exports = {createSocialAnalyticsEvidence, EVIDENCE_KINDS: KINDS, EVIDENCE_SOURCES: SOURCES, EVIDENCE_COMPLETENESS: COMPLETENESS};
