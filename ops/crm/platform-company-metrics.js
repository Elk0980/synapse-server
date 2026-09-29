'use strict';
/* Фактические показатели компании в 2ГИС: показы, переходы, действия и обращения.
   Модуль только принимает уже собранные отчёты и показывает их. Внешних запросов нет,
   автоматического сбора нет, числа не досчитываются и не переводятся в другие единицы.

   Почему отдельные таблицы, а не platform_demand_datasets: там живёт спрос по рубрикам
   (rubric_demand/search_share) с обязательным точным временем снятия. Фактические показы
   компании — другая сущность, у официальных выгрузок нет времени снятия, и подменять ими
   спрос нельзя. external_stats тоже не подходит: он складывает произвольные поля. */
const {createHash} = require('node:crypto');

const ERRORS = Object.freeze({
  VALIDATION_ERROR: 'Проверьте поля отчёта, даты и показатели.',
  NOT_FOUND: 'Отчёт не найден для текущей компании и организации.',
  CONFIGURATION_REQUIRED: 'Сначала сохраните организацию и филиал 2ГИС для выбранной компании.',
  ORG_MISMATCH: 'Организация или филиал отчёта не совпадают с настройками выбранной компании.',
  REVISION_CONFLICT: 'Настройки 2ГИС изменились. Обновите страницу и повторите загрузку.',
  CONFIRMATION_REQUIRED: 'Эти даты уже загружены. Проверьте изменения в предпросмотре и подтвердите замену.',
  PREVIEW_STALE: 'Данные или состав пакета изменились после предпросмотра. Повторите предпросмотр и подтвердите заново.',
});
const fail = (code = 'VALIDATION_ERROR', status = 400) => { throw Object.assign(Error(ERRORS[code]), {code, status}); };

/* Закрытый словарь. Ничего кроме этих одиннадцати рядов модуль не принимает.
   aggregation: sum — счётчики складываются по дням; daily_only — позиция выдачи,
   её нельзя ни суммировать, ни усреднять: это место в списке, а не количество. */
const METRICS = Object.freeze({
  appearance_views: {report: 'appearance', label: 'Показы', source: 'Показы', unit: 'count', aggregation: 'sum'},
  search_position: {report: 'appearance', label: 'Позиция в выдаче', source: 'Позиция в выдаче', unit: 'position', aggregation: 'daily_only'},
  page_visits: {report: 'pagevisits', label: 'Переходы на страницу', source: 'Переходы на страницу', unit: 'count', aggregation: 'sum'},
  page_actions: {report: 'pagevisits', label: 'Действия на странице', source: 'Действия на странице', unit: 'count', aggregation: 'sum'},
  calls_and_phone_views: {report: 'connections', label: 'Звонки и просмотры телефона', source: 'Звонки и просмотры телефона', unit: 'count', aggregation: 'sum'},
  address_clicks: {report: 'connections', label: 'Клики в адрес', source: 'Клики в адрес', unit: 'count', aggregation: 'sum'},
  site_visits: {report: 'connections', label: 'Переходы на сайт', source: 'Переходы на сайт', unit: 'count', aggregation: 'sum'},
  route_builds: {report: 'connections', label: 'Построения маршрутов', source: 'Построения маршрутов', unit: 'count', aggregation: 'sum'},
  social_clicks: {report: 'connections', label: 'Клики в соцсети', source: 'Клики в соцсети', unit: 'count', aggregation: 'sum'},
  messenger_clicks: {report: 'connections', label: 'Клики в мессенджеры', source: 'Клики в мессенджеры', unit: 'count', aggregation: 'sum'},
  ad_link_clicks: {report: 'connections', label: 'Переходы по рекламной ссылке', source: 'Переходы по рекламной ссылке', unit: 'count', aggregation: 'sum'},
});
const REPORT_KINDS = Object.freeze({appearance: 'Видимость', pagevisits: 'Страница компании', connections: 'Обращения'});
const SOURCE_KINDS = Object.freeze({official_xlsx: 'Официальная выгрузка кабинета (XLSX)', visible_table: 'Снимок видимой таблицы кабинета'});
/* Ограничение относится только к странице компании: в исходной ячейке отчёта переходов
   написано «Данные без учёта данных сайтов партнёров». На другие отчёты оно не переносится. */
const SCOPE_NOTES = Object.freeze({partner_sites_excluded: 'Данные без учёта данных сайтов партнёров'});
const SCOPE_NOTE_REPORTS = Object.freeze({partner_sites_excluded: ['pagevisits']});

const MAX_ROWS_PER_REPORT = 2000;
const MAX_REPORTS_PER_PACKAGE = 12;

const text = (value, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
  const out = value.trim(); if (required && !out) fail(); return out;
};
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail();
};
const organization = (value) => { if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) fail(); return value; };
const revisionOf = (value) => { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };
/* Даты хранятся календарными строками как в источнике: часовой пояс отчёта неизвестен,
   и переводить их в UTC — значит выдумать смещение. */
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail();
  return value;
};
const timestamp = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) fail();
  return parsed.toISOString();
};
const sha256Hex = (value) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; };
/* Часовой пояс отчёта: либо название зоны, либо null — «неизвестен». Пустой строкой не подменяется. */
const timezoneOf = (value) => {
  if (value === null || value === undefined) return null;
  const raw = text(value, 64);
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(raw)) fail();
  /* Зона проверяется настоящим списком IANA через Intl, а не формой строки:
     «Mars/Olympus» выглядит как зона, но зоной не является и не должен давать
     timezoneKnown=true. null остаётся честным «неизвестно». */
  try { new Intl.DateTimeFormat('en-US', {timeZone: raw}); } catch { fail(); }
  return raw;
};
/* Ссылка на кабинет проверяется по организации. Филиал из URL НЕ выводится: все наши
   источники дают ссылку уровня организации. Но если в ссылке явно указан другой филиал —
   это чужая привязка, и такой отчёт принимать нельзя. */
function cabinetUrl(value, org, branch = null) {
  const raw = text(value, 2000); let url;
  try { url = new URL(raw); } catch { fail(); }
  if (url.protocol !== 'https:' || url.hostname !== 'account.2gis.com' || url.port || url.username || url.password ||
    /[\\\s]/.test(raw) || !url.pathname.startsWith('/orgs/' + org + '/') || !/^\/orgs\/\d+\/[A-Za-z0-9_/-]*$/.test(url.pathname)) fail('ORG_MISMATCH', 409);
  if (url.hash) fail();
  const inUrl = /^\/orgs\/\d+\/branches\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (inUrl && branch !== null && inUrl[1] !== branch) fail('ORG_MISMATCH', 409);
  for (const [key, item] of url.searchParams) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(key) || item.length > 100 || /[\u0000-\u001f]/.test(item)) fail();
  }
  return url.href;
}

function createPlatformCompanyMetrics(db, {now = () => Date.now()} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_company_metric_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, organization_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    report_kind TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, granularity TEXT NOT NULL DEFAULT 'day',
    timezone TEXT, captured_date TEXT NOT NULL, captured_at TEXT, source_kind TEXT NOT NULL, source_url TEXT NOT NULL,
    original_filename TEXT, original_file_sha256 TEXT, content_hash TEXT NOT NULL, scope_note TEXT NOT NULL DEFAULT '',
    settings_revision INTEGER NOT NULL, version INTEGER NOT NULL, superseded_by INTEGER, imported_at TEXT NOT NULL,
    actor_id INTEGER, actor_name TEXT, rows_json TEXT NOT NULL,
    UNIQUE(company_code, content_hash, version));
    CREATE INDEX IF NOT EXISTS platform_company_metric_reports_scope
      ON platform_company_metric_reports(company_code, organization_id, branch_id, report_kind, period_start);
    CREATE TABLE IF NOT EXISTS platform_company_metric_values (
      report_id INTEGER NOT NULL REFERENCES platform_company_metric_reports(id) ON DELETE CASCADE,
      company_code TEXT NOT NULL, organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, report_kind TEXT NOT NULL,
      date TEXT NOT NULL, metric TEXT NOT NULL, value REAL, source_label TEXT NOT NULL DEFAULT '',
      source_position TEXT NOT NULL DEFAULT '', superseded_by INTEGER, PRIMARY KEY(report_id, date, metric));
    CREATE INDEX IF NOT EXISTS platform_company_metric_values_scope
      ON platform_company_metric_values(company_code, organization_id, branch_id, metric, date);
    CREATE TABLE IF NOT EXISTS platform_company_metrics_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
      actor_id INTEGER, actor_name TEXT, created_at TEXT NOT NULL);`);
  /* Первая поставка модуля: таблицы создаются здесь и в production их ещё не было,
     поэтому миграции прежней схемы нет и она не объявляется рабочей. Если в базе разработчика
     осталась таблица от недоставленного прототипа (без superseded_by у значений), молча
     продолжать нельзя: активность значений восстановить из неё нечем, а неверные суммы хуже
     явной остановки. Такие три таблицы удаляются вручную, данных production в них нет. */
  if (!db.prepare("SELECT 1 FROM pragma_table_info('platform_company_metric_values') WHERE name='superseded_by'").get())
    throw Object.assign(Error('Таблицы фактических показателей 2ГИС остались от прототипа без колонки superseded_by. Удалите platform_company_metric_values, platform_company_metric_reports и platform_company_metrics_audit: модуль ещё не выпускался, данных production в них нет.'), {code: 'SCHEMA_INCOMPATIBLE'});
  db.exec(`CREATE INDEX IF NOT EXISTS platform_company_metric_values_active
    ON platform_company_metric_values(company_code, organization_id, branch_id, report_kind, date, metric, superseded_by);`);

  const stamp = () => new Date(now()).toISOString();
  const transact = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const audit = (code, action, payload, actor) => db.prepare(
    'INSERT INTO platform_company_metrics_audit(company_code,action,payload,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?)')
    .run(code, action, JSON.stringify(payload), actor?.userId ?? null, actor?.userName ?? null, stamp());

  function company(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail();
    const row = db.prepare('SELECT code,name FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) fail('NOT_FOUND', 404);
    return row;
  }
  /* Привязка организации переиспользуется из настроек 2ГИС. Филиал обязателен именно здесь:
     показатели снимаются по конкретному филиалу, и без подтверждённого филиала отчёт не принимается.
     Прежние настройки без филиала остаются рабочими для спроса по рубрикам. */
  const settingsRow = (code) => db.prepare('SELECT * FROM platform_demand_settings WHERE company_code=?').get(code);
  function scope(code) {
    const config = settingsRow(code);
    if (!config || !config.organization_id) fail('CONFIGURATION_REQUIRED', 409);
    const branch = typeof config.branch_id === 'string' ? config.branch_id.trim() : '';
    if (!branch) fail('CONFIGURATION_REQUIRED', 409);
    return {organizationId: config.organization_id, branchId: branch, revision: config.revision ?? 0};
  }

  /* Состояние данных компании в её организации/филиале. Любое принятие отчёта вставляет
     строку в reports, поэтому счётчик строк — достаточный признак «данные изменились».
     Он нужен, чтобы устаревшее подтверждение предпросмотра не записалось поверх изменений,
     которых владелец не видел: одной ревизии настроек для этого мало. */
  const dataRevision = (code, config) => db.prepare(
    `SELECT COUNT(*) n FROM platform_company_metric_reports
     WHERE company_code=? COLLATE NOCASE AND organization_id=? AND branch_id=?`)
    .get(code, config.organizationId, config.branchId).n;
  /* Отпечаток именно того пакета, который был показан в предпросмотре. Подтверждение
     привязано к нему: подменить состав отчётов между предпросмотром и импортом нельзя. */
  const packageHashOf = (prepared) => createHash('sha256')
    .update(JSON.stringify(prepared.map((item) => JSON.stringify(item)).sort())).digest('hex');

  /* Внутри одного пакета два отчёта не могут говорить о том же date+metric: иначе
     второй молча заменил бы первый, и ни предпросмотр, ни подтверждение этого не показали бы.
     Такой пакет отклоняется целиком ещё до предпросмотра. */
  function packageGuard(prepared) {
    const hashes = new Set(), keys = new Set();
    for (const report of prepared) {
      if (hashes.has(report.contentHash)) fail();
      hashes.add(report.contentHash);
      for (const row of report.rows) {
        const key = report.reportKind + '|' + row.date + '|' + row.metric;
        if (keys.has(key)) fail();
        keys.add(key);
      }
    }
  }

  /* Повтор определяется текущим состоянием, а не наличием такого же отчёта в истории.
     Отчёт ничего не меняет ровно тогда, когда каждое его значение уже действует с тем же
     числом. Поэтому A(10) → B(20) → снова A(10) — это корректировка, которую предпросмотр
     показал и владелец подтвердил, а не «уже загружено»; а повтор только что восстановленного
     A действительно ничего не добавляет. Прежние версии остаются в истории неизменными. */
  /* Условия сбора и существенное происхождение значения. Те же числа, снятые в другом
     часовом поясе, с другим охватом источника или подтверждённые официальной выгрузкой
     вместо снимка видимой таблицы, — это НЕ повтор: меняется сопоставимость рядов и то,
     чем значение подтверждено. Имя файла сюда не входит: переименование того же файла
     новой версии не создаёт, как и перестановка строк. */
  const CONDITION_FIELDS = Object.freeze([
    {key: 'timezone', label: 'часовой пояс', of: (report) => report.timezone, row: (row) => row.timezone ?? null,
      show: (value) => value || 'не указан'},
    {key: 'scopeNote', label: 'охват источника', of: (report) => report.scopeNote || '', row: (row) => row.scope_note || '',
      show: (value) => (value ? SCOPE_NOTES[value] || value : 'без ограничения')},
    {key: 'sourceKind', label: 'вид источника', of: (report) => report.sourceKind, row: (row) => row.source_kind,
      show: (value) => SOURCE_KINDS[value] || value},
    {key: 'originalFileSha256', label: 'SHA256 исходного файла',
      of: (report) => report.originalFileSha256 ?? null, row: (row) => row.original_file_sha256 ?? null,
      show: (value) => (value ? value.slice(0, 12) + '…' : 'не указан')},
  ]);
  const sameConditions = (report, row) => CONDITION_FIELDS.every((field) => field.of(report) === field.row(row));
  const conditionDiff = (report, row) => CONDITION_FIELDS.filter((field) => field.of(report) !== field.row(row))
    .map((field) => ({field: field.key, label: field.label,
      previous: field.show(field.row(row)), next: field.show(field.of(report))}));

  function redundant(code, config, report) {
    const active = new Map(activeValues(code, config, report.reportKind, report.start, report.end)
      .map((row) => [row.date + '|' + row.metric, row]));
    return report.rows.every((row) => {
      const previous = active.get(row.date + '|' + row.metric);
      return previous && (previous.value ?? null) === (row.value ?? null) && sameConditions(report, previous);
    });
  }
  const sameContent = (code, report) => db.prepare(
    `SELECT id,version FROM platform_company_metric_reports WHERE company_code=? COLLATE NOCASE AND content_hash=?
     ORDER BY version DESC LIMIT 1`).get(code, report.contentHash) ?? null;

  const metricDefinitions = () => Object.entries(METRICS).map(([id, item]) => ({
    metric: id, label: item.label, sourceLabel: item.source, reportKind: item.report, unit: item.unit, aggregation: item.aggregation,
  }));

  function normalizeRows(reportKind, granularity, start, end, rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS_PER_REPORT) fail();
    const seen = new Set();
    const out = rows.map((row) => {
      object(row, ['date', 'metric', 'value', 'sourceLabel', 'sourcePosition']);
      const day = date(row.date);
      if (day < start || day > end) fail();
      const metric = row.metric;
      if (typeof metric !== 'string' || !Object.hasOwn(METRICS, metric) || METRICS[metric].report !== reportKind) fail();
      const definition = METRICS[metric];
      // null — значения нет; 0 — измеренный ноль. Одно другим не подменяется.
      let value = null;
      if (row.value !== null && row.value !== undefined) {
        if (typeof row.value !== 'number' || !Number.isFinite(row.value)) fail();
        if (definition.aggregation === 'sum') {
          if (!Number.isSafeInteger(row.value) || row.value < 0 || row.value > 1e12) fail();
        } else if (!(row.value > 0) || row.value > 1e6) fail();
        value = row.value;
      }
      const label = row.sourceLabel === undefined ? definition.source : text(row.sourceLabel, 200);
      // Точное место значения в источнике: ячейка Excel или JSON Pointer видимой таблицы.
      const position = row.sourcePosition === undefined ? '' : text(row.sourcePosition, 200, false);
      if (position && !/^(?:[A-Z]{1,3}[1-9]\d{0,6}|\/[ -~]{0,190})$/.test(position)) fail();
      const key = day + '|' + metric;
      if (seen.has(key)) fail();
      seen.add(key);
      return {date: day, metric, value, sourceLabel: label, sourcePosition: position};
    });
    if (granularity !== 'day') fail();
    // Порядок строк на смысл не влияет: сортировка делает отпечаток независимым от него.
    return out.sort((a, b) => (a.date === b.date ? a.metric.localeCompare(b.metric) : a.date.localeCompare(b.date)));
  }

  function normalizeReport(body, current, config) {
    object(body, ['reportKind', 'periodStart', 'periodEnd', 'granularity', 'timezone', 'capturedDate', 'capturedAt',
      'sourceKind', 'sourceUrl', 'originalFilename', 'originalFileSha256', 'scopeNote', 'rows']);
    const reportKind = body.reportKind;
    if (typeof reportKind !== 'string' || !Object.hasOwn(REPORT_KINDS, reportKind)) fail();
    const sourceKind = body.sourceKind;
    if (typeof sourceKind !== 'string' || !Object.hasOwn(SOURCE_KINDS, sourceKind)) fail();
    const start = date(body.periodStart), end = date(body.periodEnd);
    if (start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 400) fail();
    const granularity = body.granularity === undefined ? 'day' : body.granularity;
    if (granularity !== 'day') fail();
    const timezone = timezoneOf(body.timezone);
    // Дата снятия — календарный день без часового пояса; точное время известно не всегда.
    const capturedDate = date(body.capturedDate);
    const capturedAt = body.capturedAt === null || body.capturedAt === undefined ? null : timestamp(body.capturedAt);
    if (capturedAt && capturedAt.slice(0, 10) !== capturedDate) fail();
    if (capturedDate < end) fail();
    if (Date.parse(capturedDate + 'T00:00:00Z') > now() + 86400000) fail();
    const url = cabinetUrl(body.sourceUrl, config.organizationId, config.branchId);
    const filename = body.originalFilename === null || body.originalFilename === undefined ? null : text(body.originalFilename, 255, false) || null;
    if (filename && /[\\/]/.test(filename)) fail();
    // SHA256 исходного файла приходит вместе с отчётом. Байтов оригинала у сервера нет,
    // поэтому он этот отпечаток НЕ пересчитывает и своей проверкой не называет.
    const originalFileSha256 = body.originalFileSha256 === null || body.originalFileSha256 === undefined ? null : sha256Hex(body.originalFileSha256);
    const scopeNote = body.scopeNote === null || body.scopeNote === undefined || body.scopeNote === '' ? '' : text(body.scopeNote, 64);
    if (scopeNote) {
      if (!Object.hasOwn(SCOPE_NOTES, scopeNote)) fail();
      if (!SCOPE_NOTE_REPORTS[scopeNote].includes(reportKind)) fail();
    }
    const rows = normalizeRows(reportKind, granularity, start, end, body.rows);
    /* Отпечаток содержимого считает сам сервер и только по смыслу отчёта: компания, организация,
       филиал, вид отчёта, период, часовой пояс и отсортированные значения. Порядок строк,
       имя файла, время импорта и ссылка в него не входят. */
    const contentHash = createHash('sha256').update(JSON.stringify({
      companyCode: current.code.toLowerCase(), organizationId: config.organizationId, branchId: config.branchId,
      reportKind, start, end, granularity, timezone, scopeNote,
      rows: rows.map((row) => [row.date, row.metric, row.value]),
    })).digest('hex');
    return {reportKind, start, end, granularity, timezone, capturedDate, capturedAt, sourceKind, url, filename,
      originalFileSha256, scopeNote, rows, contentHash};
  }

  const activeValues = (code, config, reportKind, from, to) => db.prepare(
    `SELECT v.date,v.metric,v.value,v.source_label,v.source_position,v.report_id,r.timezone,r.scope_note,r.version,r.captured_date,r.captured_at,r.source_kind,r.original_file_sha256
     FROM platform_company_metric_values v JOIN platform_company_metric_reports r ON r.id=v.report_id
     WHERE v.company_code=? COLLATE NOCASE AND v.organization_id=? AND v.branch_id=? AND v.report_kind=?
       AND v.superseded_by IS NULL AND v.date>=? AND v.date<=? ORDER BY v.date,v.metric`)
    .all(code, config.organizationId, config.branchId, reportKind, from, to);

  /* Что именно изменится, если принять этот отчёт: какие даты и показатели уже загружены
     и с какими значениями. Пока владелец не подтвердил замену, ничего не пишется. */
  function conflictsFor(code, config, report) {
    const existing = new Map(activeValues(code, config, report.reportKind, report.start, report.end)
      .map((row) => [row.date + '|' + row.metric, row]));
    const changes = [];
    for (const row of report.rows) {
      const previous = existing.get(row.date + '|' + row.metric);
      if (!previous) continue;
      const conditions = conditionDiff(report, previous);
      changes.push({date: row.date, metric: row.metric, metricLabel: METRICS[row.metric].label,
        previousValue: previous.value === null || previous.value === undefined ? null : previous.value,
        nextValue: row.value, changed: (previous.value ?? null) !== (row.value ?? null),
        conditionsChanged: conditions.length > 0, reportId: previous.report_id});
    }
    return changes;
  }

  function reportDto(row, withRows = false) {
    const rows = JSON.parse(row.rows_json);
    return {
      id: row.id, reportKind: row.report_kind, reportKindLabel: REPORT_KINDS[row.report_kind] || row.report_kind,
      periodStart: row.period_start, periodEnd: row.period_end, granularity: row.granularity,
      timezone: row.timezone ?? null, timezoneKnown: Boolean(row.timezone),
      capturedDate: row.captured_date, capturedAt: row.captured_at ?? null,
      capturedAtKnown: Boolean(row.captured_at),
      sourceKind: row.source_kind, sourceKindLabel: SOURCE_KINDS[row.source_kind] || row.source_kind,
      sourceUrl: row.source_url, originalFilename: row.original_filename ?? null,
      originalFileSha256: row.original_file_sha256 ?? null,
      // Отпечаток оригинала пришёл вместе с отчётом; отпечаток содержимого посчитан сервером.
      originalFileSha256Verified: false, contentHash: row.content_hash,
      scopeNote: row.scope_note || '', scopeNoteLabel: row.scope_note ? SCOPE_NOTES[row.scope_note] : '',
      settingsRevision: row.settings_revision, version: row.version, supersededBy: row.superseded_by ?? null,
      importedAt: row.imported_at, actorName: row.actor_name ?? null,
      rowCount: rows.length, knownValues: rows.filter((item) => item.value !== null).length,
      ...(withRows ? {rows} : {}),
    };
  }

  function preview(code, body, actor) {
    const current = company(code);
    object(body, ['reports']);
    const config = scope(current.code);
    if (!Array.isArray(body.reports) || !body.reports.length || body.reports.length > MAX_REPORTS_PER_PACKAGE) fail();
    const prepared = body.reports.map((item) => normalizeReport(item, current, config));
    // Один и тот же отчёт дважды в одном пакете — ошибка пакета целиком, а не молчаливое склеивание.
    packageGuard(prepared);
    const reports = prepared.map((report) => {
      const previousSame = sameContent(current.code, report);
      const noop = redundant(current.code, config, report);
      const conflicts = conflictsFor(current.code, config, report);
      return {
        reportKind: report.reportKind, reportKindLabel: REPORT_KINDS[report.reportKind],
        periodStart: report.start, periodEnd: report.end, granularity: report.granularity,
        timezone: report.timezone, timezoneKnown: Boolean(report.timezone),
        capturedDate: report.capturedDate, capturedAt: report.capturedAt, capturedAtKnown: Boolean(report.capturedAt),
        sourceKind: report.sourceKind, sourceKindLabel: SOURCE_KINDS[report.sourceKind], sourceUrl: report.url,
        originalFilename: report.filename, originalFileSha256: report.originalFileSha256, originalFileSha256Verified: false,
        scopeNote: report.scopeNote, scopeNoteLabel: report.scopeNote ? SCOPE_NOTES[report.scopeNote] : '',
        contentHash: report.contentHash, rowCount: report.rows.length,
        knownValues: report.rows.filter((row) => row.value !== null).length,
        zeroValues: report.rows.filter((row) => row.value === 0).length,
        metrics: [...new Set(report.rows.map((row) => row.metric))].sort(),
        dates: [...new Set(report.rows.map((row) => row.date))].sort(),
        /* alreadyImported — «эти числа уже действуют», а не «такой отчёт когда-то был».
           previousVersionId показывает прежнюю версию с тем же содержимым, если она была. */
        alreadyImported: noop, previousVersionId: previousSame?.id ?? null,
        restoresPreviousValues: Boolean(previousSame) && !noop,
        conflicts, conflictCount: conflicts.length, changedValues: conflicts.filter((item) => item.changed).length,
        /* Изменились условия сбора или подтверждение источника при тех же числах: молча
           потерять это нельзя, поэтому такая загрузка принимается как новая версия. */
        conditionChanges: [...new Map(conflicts.flatMap((item) => conditionDiff(report,
          db.prepare('SELECT timezone,scope_note,source_kind,original_file_sha256 FROM platform_company_metric_reports WHERE id=?')
            .get(item.reportId)))
          .map((item) => [item.field + '|' + item.previous + '|' + item.next, item])).values()],
        unchangedValuesWithNewConditions: conflicts.filter((item) => !item.changed && item.conditionsChanged).length,
      };
    });
    const conflictCount = reports.reduce((sum, item) => sum + item.conflictCount, 0);
    return {
      companyCode: current.code.toLowerCase(), organizationId: config.organizationId, branchId: config.branchId,
      settingsRevision: config.revision, dataRevision: dataRevision(current.code, config),
      packageHash: packageHashOf(prepared), reports, conflictCount,
      requiresConfirmation: conflictCount > 0,
      conditionsOnly: conflictCount > 0 && reports.every((item) => item.changedValues === 0)
        && reports.some((item) => item.conditionChanges.length > 0),
      note: !conflictCount
        ? 'Совпадающих дат нет: загрузка добавит новые значения и ничего не заменит.'
        : reports.every((item) => item.changedValues === 0) && reports.some((item) => item.conditionChanges.length > 0)
          ? 'Числа те же, но изменились условия сбора или подтверждение источника. Это не повтор: загрузка сохранит новую версию с новым происхождением, прежняя останется в истории.'
          : 'Эти даты уже загружены. Проверьте, что именно изменится, и подтвердите замену: прежние значения сохранятся как предыдущая версия.',
    };
  }

  function importReports(code, body, actor) {
    const current = company(code);
    object(body, ['settingsRevision', 'dataRevision', 'packageHash', 'confirmReplace', 'reports']);
    revisionOf(body.settingsRevision);
    revisionOf(body.dataRevision);
    const packageHash = sha256Hex(body.packageHash);
    const confirm = body.confirmReplace === undefined ? false : body.confirmReplace;
    if (typeof confirm !== 'boolean') fail();
    const config = scope(current.code);
    // Подтверждается именно текущая ревизия настроек: устаревший импорт не проходит.
    if (config.revision !== body.settingsRevision) fail('REVISION_CONFLICT', 409);
    if (!Array.isArray(body.reports) || !body.reports.length || body.reports.length > MAX_REPORTS_PER_PACKAGE) fail();
    const prepared = body.reports.map((item) => normalizeReport(item, current, config));
    packageGuard(prepared);
    // Подтверждается ровно тот пакет, который показывали в предпросмотре.
    if (packageHashOf(prepared) !== packageHash) fail('PREVIEW_STALE', 409);
    // Пакет атомарный: любая непринятая строка отменяет весь импорт, частичной записи не бывает.
    return transact(() => {
      const fresh = scope(current.code);
      if (fresh.revision !== body.settingsRevision || fresh.organizationId !== config.organizationId || fresh.branchId !== config.branchId) fail('REVISION_CONFLICT', 409);
      /* Состояние данных проверяется внутри транзакции и до любых записей: если после
         предпросмотра кто-то успел загрузить другие значения, владелец их не видел —
         импорт отклоняется целиком и просит новый предпросмотр. */
      if (dataRevision(current.code, fresh) !== body.dataRevision) fail('PREVIEW_STALE', 409);
      const at = stamp();
      const accepted = [], skipped = [];
      for (const report of prepared) {
        // Пропускается только то, что действительно ничего не меняет в текущем состоянии.
        if (redundant(current.code, config, report)) {
          skipped.push({reportKind: report.reportKind, reportId: sameContent(current.code, report)?.id ?? null,
            reason: 'already_active'});
          continue;
        }
        const conflicts = conflictsFor(current.code, config, report);
        if (conflicts.length && !confirm) fail('CONFIRMATION_REQUIRED', 409);
        const previousVersion = db.prepare(
          `SELECT MAX(version) v FROM platform_company_metric_reports WHERE company_code=? COLLATE NOCASE AND organization_id=? AND branch_id=? AND report_kind=?`)
          .get(current.code, config.organizationId, config.branchId, report.reportKind).v || 0;
        const id = Number(db.prepare(`INSERT INTO platform_company_metric_reports(company_code,organization_id,branch_id,report_kind,period_start,period_end,
          granularity,timezone,captured_date,captured_at,source_kind,source_url,original_filename,original_file_sha256,content_hash,scope_note,
          settings_revision,version,superseded_by,imported_at,actor_id,actor_name,rows_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`)
          .run(current.code.toLowerCase(), config.organizationId, config.branchId, report.reportKind, report.start, report.end,
            report.granularity, report.timezone, report.capturedDate, report.capturedAt, report.sourceKind, report.url,
            report.filename, report.originalFileSha256, report.contentHash, report.scopeNote,
            config.revision, previousVersion + 1, at, actor?.userId ?? null, actor?.userName ?? null,
            JSON.stringify(report.rows)).lastInsertRowid);
        const insert = db.prepare(`INSERT INTO platform_company_metric_values(report_id,company_code,organization_id,branch_id,report_kind,date,metric,value,source_label,source_position)
          VALUES(?,?,?,?,?,?,?,?,?,?)`);
        for (const row of report.rows) {
          /* Прежнее действующее значение этого же date+metric помечается заменённым именно
             этим отчётом. Остальные дни и остальные метрики прежнего отчёта продолжают
             действовать; история и происхождение остаются в базе. */
          db.prepare(`UPDATE platform_company_metric_values SET superseded_by=?
            WHERE company_code=? COLLATE NOCASE AND organization_id=? AND branch_id=? AND report_kind=?
              AND date=? AND metric=? AND superseded_by IS NULL`)
            .run(id, current.code, config.organizationId, config.branchId, report.reportKind, row.date, row.metric);
          insert.run(id, current.code.toLowerCase(), config.organizationId, config.branchId, report.reportKind,
            row.date, row.metric, row.value, row.sourceLabel, row.sourcePosition);
        }
        /* Отчёт целиком заменённым считается только тогда, когда у него не осталось ни одного
           действующего значения. Частичная замена дня или метрики отчёт не хоронит. */
        if (conflicts.length) {
          const replaced = [...new Set(conflicts.map((item) => item.reportId))];
          const mark = db.prepare('UPDATE platform_company_metric_reports SET superseded_by=? WHERE id=? AND company_code=? COLLATE NOCASE AND superseded_by IS NULL');
          const alive = db.prepare('SELECT COUNT(*) n FROM platform_company_metric_values WHERE report_id=? AND superseded_by IS NULL');
          for (const previous of replaced) { if (!alive.get(previous).n) mark.run(id, previous, current.code); }
        }
        accepted.push({reportId: id, reportKind: report.reportKind, version: previousVersion + 1,
          rowCount: report.rows.length, replacedValues: conflicts.length});
      }
      audit(current.code, 'company_metrics_import',
        {accepted: accepted.map((item) => item.reportId), skipped: skipped.map((item) => item.reportId), confirmReplace: confirm}, actor);
      return {companyCode: current.code.toLowerCase(), imported: accepted, skipped,
        dataRevision: dataRevision(current.code, fresh),
        note: 'Версия отчёта — порядок принятого импорта, а не время снятия: у официальных выгрузок точного времени нет.'};
    });
  }

  function getReport(code, id) {
    const current = company(code), config = scope(current.code);
    if (!/^[1-9]\d{0,15}$/.test(String(id))) fail('NOT_FOUND', 404);
    const row = db.prepare(`SELECT * FROM platform_company_metric_reports WHERE id=? AND company_code=? COLLATE NOCASE AND organization_id=? AND branch_id=?`)
      .get(Number(id), current.code, config.organizationId, config.branchId);
    if (!row) fail('NOT_FOUND', 404);
    return {report: reportDto(row, true), metricDefinitions: metricDefinitions()};
  }

  /* Сводка за период. Счётчики складываются по дням; позиция выдачи — только дневной ряд,
     без суммы и без среднего. Категории обращений между собой не складываются и с действиями
     на странице тоже: пересечение совокупностей неизвестно. */
  function summary(code, from, to) {
    const current = company(code), config = scope(current.code);
    const start = date(from), end = date(to);
    if (start > end) fail();
    const reports = db.prepare(`SELECT * FROM platform_company_metric_reports WHERE company_code=? COLLATE NOCASE AND organization_id=? AND branch_id=?
      ORDER BY imported_at DESC, id DESC`).all(current.code, config.organizationId, config.branchId);
    /* Действующие значения берутся по ключу date+metric, а не по отчётам: после частичной
       замены один и тот же отчёт может быть действующим на одних днях и заменённым на других. */
    const rows = [];
    for (const reportKind of Object.keys(REPORT_KINDS)) {
      for (const row of activeValues(current.code, config, reportKind, start, end)) rows.push({...row, reportKind});
    }
    const activeIds = new Set(rows.map((row) => row.report_id));
    const active = reports.filter((row) => activeIds.has(row.id));
    const metrics = [];
    for (const [metric, definition] of Object.entries(METRICS)) {
      const mine = rows.filter((row) => row.metric === metric);
      const known = mine.filter((row) => row.value !== null && row.value !== undefined);
      const zones = [...new Set(mine.map((row) => row.timezone ?? null).map((zone) => zone || 'unknown'))];
      /* Пустой scopeNote и partner_sites_excluded — РАЗНЫЕ условия сбора. Отбрасывать пустое
         нельзя: иначе отчёт с ограничением и отчёт без него молча сложились бы в один итог. */
      const notes = [...new Set(mine.map((row) => row.scope_note || ''))];
      // Разные условия отчётов в один итог не сводятся.
      const comparable = zones.length <= 1 && notes.length <= 1;
      const total = definition.aggregation === 'sum' && known.length && comparable
        ? known.reduce((sum, row) => sum + row.value, 0) : null;
      metrics.push({
        metric, label: definition.label, sourceLabel: definition.source, unit: definition.unit,
        reportKind: definition.report, reportKindLabel: REPORT_KINDS[definition.report], aggregation: definition.aggregation,
        total, totalAvailable: total !== null,
        totalNote: definition.aggregation === 'daily_only'
          ? 'Позиция в выдаче не суммируется и не усредняется: это место в списке, а не количество.'
          : !comparable ? 'Итог не считается: значения собраны при разных условиях и в один ряд не сводятся.' : '',
        min: definition.aggregation === 'daily_only' && known.length ? Math.min(...known.map((row) => row.value)) : null,
        max: definition.aggregation === 'daily_only' && known.length ? Math.max(...known.map((row) => row.value)) : null,
        daysWithValue: known.length, daysWithoutValue: mine.length - known.length,
        zeroDays: known.filter((row) => row.value === 0).length,
        firstDate: mine.length ? mine.map((row) => row.date).sort()[0] : null,
        lastDate: mine.length ? mine.map((row) => row.date).sort().at(-1) : null,
        scopeNotes: notes.filter(Boolean).map((note) => SCOPE_NOTES[note] || note),
        mixedConditions: !comparable,
        timezoneKnown: zones.length === 1 && zones[0] !== 'unknown',
        days: mine.map((row) => ({date: row.date, value: row.value ?? null, hasValue: row.value !== null && row.value !== undefined,
          reportId: row.report_id, sourcePosition: row.source_position || ''})).sort((a, b) => a.date.localeCompare(b.date)),
      });
    }
    const expectedDays = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
    const coverage = {
      period: {from: start, to: end}, expectedDays,
      reportsActive: active.length, reportsTotal: reports.length,
      reportsSuperseded: reports.filter((row) => row.superseded_by !== null).length,
      metricsWithData: metrics.filter((item) => item.daysWithValue > 0).length, metricsTotal: metrics.length,
      valuesRead: rows.length, knownValues: metrics.reduce((sum, item) => sum + item.daysWithValue, 0),
      zeroValues: metrics.reduce((sum, item) => sum + item.zeroDays, 0),
      /* dates — все даты, по которым есть строки, включая строки без значения.
         datesWithValue — дни, за которые есть хотя бы одно измерение. Это разные числа,
         и подписывать количество значений словом «дни» нельзя. */
      dates: [...new Set(rows.map((row) => row.date))].sort(),
      datesWithValue: [...new Set(rows.filter((row) => row.value !== null && row.value !== undefined)
        .map((row) => row.date))].sort(),
      capturedDates: [...new Set(active.map((row) => row.captured_date))].sort(),
      capturedAtKnown: active.length > 0 && active.every((row) => Boolean(row.captured_at)),
      timezoneKnown: active.length > 0 && active.every((row) => Boolean(row.timezone)),
      note: 'Полнота подтверждается только загруженными отчётами: это не доказательство полноты кабинета 2ГИС.',
    };
    const visible = [], limits = [], next = [];
    if (!rows.length) {
      visible.push('Загруженных показателей за этот период нет.');
      limits.push('Без загруженных отчётов о видимости и обращениях сказать нечего: данных недостаточно.');
      next.push('Загрузить подготовленный файл отчётов за нужный период.');
    } else {
      const measuredDays = coverage.datesWithValue.length;
      visible.push(`Показателей с данными: ${coverage.metricsWithData} из ${coverage.metricsTotal}; известных значений: ${coverage.knownValues}.`);
      visible.push(measuredDays
        ? `Дней с измерениями: ${measuredDays} из ${expectedDays} дней периода, с ${coverage.datesWithValue[0]} по ${coverage.datesWithValue.at(-1)}.`
        : `Дней с измерениями нет: строки за ${coverage.dates.length} дат загружены, но значения в них пустые.`);
      if (coverage.zeroValues) visible.push(`Измеренных нулей: ${coverage.zeroValues} — это значение, а не отсутствие данных.`);
      if (measuredDays < expectedDays) limits.push(`Не за все дни периода есть измерения: ${measuredDays} из ${expectedDays}.`);
      limits.push('Показы не равны охвату, переходы и действия не равны обращениям, а обращения не равны продажам.');
      limits.push('Категории обращений не складываются между собой и с действиями на странице: их пересечение неизвестно.');
      limits.push('«Звонки и просмотры телефона» — один общий ряд источника: состоявшиеся звонки из него не выделяются.');
      if (!coverage.timezoneKnown) limits.push('Часовой пояс отчётов неизвестен, поэтому даты оставлены как в источнике и к UTC не приводились.');
      if (!coverage.capturedAtKnown) limits.push('Точное время снятия известно не для всех отчётов: у официальных выгрузок его нет.');
      const scopeNotes = [...new Set(metrics.flatMap((item) => item.scopeNotes))];
      for (const note of scopeNotes) limits.push(`Ограничение источника: ${note} — относится только к своему отчёту.`);
      // Предлагать догрузку имеет смысл только если пропуски действительно есть.
      if (coverage.datesWithValue.length < expectedDays) next.push('Сверить пропущенные дни с кабинетом 2ГИС и догрузить недостающие отчёты.');
      if (metrics.some((item) => item.mixedConditions)) limits.push('Часть показателей собрана при разных условиях (часовой пояс или охват источника) — такие ряды в один итог не сводятся.');
    }
    limits.push('Конверсия между отчётами не считается: сопоставимость их совокупностей не доказана.');
    return {
      companyCode: current.code.toLowerCase(), organizationId: config.organizationId, branchId: config.branchId,
      settingsRevision: config.revision, dataRevision: dataRevision(current.code, config),
      period: {from: start, to: end},
      metrics, metricDefinitions: metricDefinitions(),
      reports: active.map((row) => reportDto(row)),
      history: reports.map((row) => reportDto(row)),
      coverage, summary: {visible, cannotConclude: limits, nextStep: next},
      note: 'Это загруженные отчёты 2ГИС, а не автоматический сбор: значения появляются только после загрузки подготовленного файла.',
    };
  }

  return {preview, importReports, summary, getReport, metricDefinitions, METRICS, REPORT_KINDS};
}

module.exports = {createPlatformCompanyMetrics, PLATFORM_COMPANY_METRICS_ERRORS: ERRORS,
  COMPANY_METRICS: METRICS, COMPANY_REPORT_KINDS: REPORT_KINDS, COMPANY_SOURCE_KINDS: SOURCE_KINDS, COMPANY_SCOPE_NOTES: SCOPE_NOTES};
