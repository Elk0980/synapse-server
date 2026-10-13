'use strict';
/* Совместимость ключа показателей публикаций (social_post_metrics) с прежним писателем.

   Новый ключ (post_id,date,metric,period) хранит day, lifetime и unknown раздельно. Прежний писатель делает
   upsert ON CONFLICT(post_id,date,metric) и с новым ключом не работает. Откат возвращает прежнюю таблицу, но
   сначала переносит каждую текущую строку в неизменяемый архив вместе с периодом, происхождением и владельцем
   поста. В прежней таблице на каждый тройной ключ остаётся одна проекция: строка единственного периода — как
   есть; несколько периодов — без значения (value NULL, completeness unknown, source_field rollback_mixed),
   потому что последнее или сумма разных периодов были бы выдумкой.

   Возврат вперёд восстанавливает архив последнего отката точно. Строка прежней таблицы считается новым
   наблюдением, только если отличается от сохранённого отпечатка своей проекции: неизменная синтетическая
   проекция наблюдением не становится. Запись прежнего писателя получает период unknown и не подменяет
   архивные day/lifetime. Столкновение с архивной unknown-строкой решает время снятия, как у самого писателя
   (новее или равное побеждает); проигравшая строка остаётся в архиве. Тройной ключ, удалённый за время отката
   (каскад от поста), не воскрешается.

   Обе операции владеют своей транзакцией и отказываются работать внутри чужой. Пересборка идёт при
   выключенном foreign_keys (порядок SQLite для изменения схемы) с возвратом исходного значения; набор постов
   без строки social_posts до и после совпадает — сироты не удаляются и не добавляются. */
const { createHash } = require('node:crypto');

const TABLE = 'social_post_metrics', REBUILD = 'social_post_metrics_period_rebuild';
const ARCHIVE = 'social_post_metrics_period_archive', CYCLES = 'social_post_metrics_period_cycles',
  CYCLE_ROWS = 'social_post_metrics_period_cycle_rows', PROJECTIONS = 'social_post_metrics_period_projections';
const TABLES = Object.freeze({ metrics: TABLE, archive: ARCHIVE, cycles: CYCLES, cycleRows: CYCLE_ROWS, projections: PROJECTIONS });
const BASE = Object.freeze(['post_id', 'date', 'metric', 'value', 'unit', 'source_field', 'completeness', 'provider', 'collected_at', 'run_id']);
const CURRENT = Object.freeze([...BASE, 'period']);
const MIXED_SOURCE = 'rollback_mixed', MIXED_PROVIDER = 'mixed', MIXED_UNIT = 'mixed';
// Столбцы и внешний ключ совпадают с social-stats.js: прежний и новый ключ отличаются только периодом.
const COLUMNS = `post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE, date TEXT NOT NULL, metric TEXT NOT NULL,
  value REAL, unit TEXT NOT NULL, source_field TEXT NOT NULL DEFAULT '', completeness TEXT NOT NULL DEFAULT 'unknown',
  provider TEXT NOT NULL, collected_at TEXT NOT NULL, run_id INTEGER`;
const currentDdl = (name) => `CREATE TABLE ${name} (${COLUMNS}, period TEXT NOT NULL DEFAULT 'unknown', PRIMARY KEY(post_id,date,metric,period))`;
const legacyDdl = (name) => `CREATE TABLE ${name} (${COLUMNS}, PRIMARY KEY(post_id,date,metric))`;
/* Архив без внешнего ключа: каскад от поста не стирает доказательства. Владелец поста (компания, площадка,
   native ID) копируется в строку, чтобы связь пережила удаление поста и проверялась при восстановлении. */
const ARCHIVE_DDL = Object.freeze({
  [CYCLES]: `cycle_id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('rollback','forward')), created_at TEXT NOT NULL`,
  [ARCHIVE]: `archive_id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL CHECK(origin IN ('period_row','legacy_write')), first_cycle_id INTEGER NOT NULL,
    company_code TEXT, platform TEXT, platform_post_id TEXT,
    post_id INTEGER NOT NULL, date TEXT NOT NULL, metric TEXT NOT NULL, period TEXT,
    value REAL, unit TEXT NOT NULL, source_field TEXT NOT NULL, completeness TEXT NOT NULL,
    provider TEXT NOT NULL, collected_at TEXT NOT NULL, run_id INTEGER, archived_at TEXT NOT NULL`,
  [CYCLE_ROWS]: `cycle_id INTEGER NOT NULL, archive_id INTEGER NOT NULL, PRIMARY KEY(cycle_id, archive_id)`,
  [PROJECTIONS]: `cycle_id INTEGER NOT NULL, post_id INTEGER NOT NULL, date TEXT NOT NULL, metric TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('exact','mixed')), periods TEXT NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(cycle_id, post_id, date, metric)`,
});
const ARCHIVE_COLUMNS = Object.freeze({
  [CYCLES]: ['cycle_id', 'kind', 'created_at'],
  [ARCHIVE]: ['archive_id', 'fingerprint', 'origin', 'first_cycle_id', 'company_code', 'platform', 'platform_post_id', ...CURRENT, 'archived_at'],
  [CYCLE_ROWS]: ['cycle_id', 'archive_id'],
  [PROJECTIONS]: ['cycle_id', 'post_id', 'date', 'metric', 'kind', 'periods', 'fingerprint'],
});

const failure = (code, message) => Object.assign(new Error(message), { code });
const sortedNames = (names) => [...names].sort().join(',');
const objectType = (db, name) => db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(name)?.type || null;
const key3 = (row) => JSON.stringify([row.post_id, row.date, row.metric]);
const key4 = (row) => JSON.stringify([row.post_id, row.date, row.metric, row.period]);
const pick = (row, columns) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
// Отпечаток различает тип значения: строка '5' и число 5 — разные наблюдения.
const canon = (value) => (value === null || value === undefined ? null
  : typeof value === 'number' ? `n:${Object.is(value, -0) ? '-0' : value}`
    : typeof value === 'bigint' ? `n:${value}`
      : typeof value === 'string' ? `s:${value}` : `b:${Buffer.from(value).toString('hex')}`);
const fingerprint = (tag, row, columns) => createHash('sha256').update(JSON.stringify([tag, ...columns.map((column) => canon(row[column]))])).digest('hex');
const inserter = (db, table, columns) => {
  const stmt = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
  return (row) => stmt.run(...columns.map((column) => row[column] ?? null));
};
const orphanPosts = (db, table) => db.prepare(`SELECT DISTINCT post_id FROM ${table} t
  WHERE NOT EXISTS (SELECT 1 FROM social_posts p WHERE p.id=t.post_id) ORDER BY post_id`).all().map((row) => row.post_id).join(',');

/* Форма таблицы. Неизвестные столбцы, ключ, внешний ключ или прикреплённые индексы/триггеры не пересобираются:
   DROP молча потерял бы их. */
function metricsShape(db) {
  const type = objectType(db, TABLE);
  if (!type) return 'absent';
  if (type !== 'table' || objectType(db, 'social_posts') !== 'table' || objectType(db, REBUILD)) {
    throw failure('MALFORMED_SCHEMA', 'social_post_metrics: не таблица, нет social_posts или остался незавершённый rebuild');
  }
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all();
  const names = sortedNames(columns.map((column) => column.name));
  const key = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name).join(',');
  const fks = db.prepare(`PRAGMA foreign_key_list(${TABLE})`).all();
  const fkOk = fks.length === 1 && fks[0].table === 'social_posts' && fks[0].from === 'post_id' && fks[0].to === 'id' && fks[0].on_delete === 'CASCADE';
  const attached = db.prepare(`SELECT 1 FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex%'`).get(TABLE);
  if (fkOk && !attached) {
    if (names === sortedNames(CURRENT) && key === 'post_id,date,metric,period') return 'current';
    if (names === sortedNames(BASE) && key === 'post_id,date,metric') return 'legacy';
    // Промежуточная форма, которую social-stats.js тоже переносит: period есть, но не в ключе.
    if (names === sortedNames(CURRENT) && key === 'post_id,date,metric') return 'legacy_period';
  }
  throw failure('MALFORMED_SCHEMA', 'social_post_metrics: неожиданные столбцы, ключ, внешний ключ или прикреплённый индекс/триггер');
}
function archivePresent(db) {
  let present = 0;
  for (const [name, expected] of Object.entries(ARCHIVE_COLUMNS)) {
    const type = objectType(db, name);
    if (!type) continue;
    if (type !== 'table' || sortedNames(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name)) !== sortedNames(expected)) {
      throw failure('MALFORMED_ARCHIVE', `${name}: неожиданная структура архива отката`);
    }
    present += 1;
  }
  if (present && present !== Object.keys(ARCHIVE_COLUMNS).length) throw failure('MALFORMED_ARCHIVE', 'архив отката неполон');
  return present > 0;
}
// Неизменяемость обеспечивает сама база: UPDATE и DELETE архива отклоняются для любого кода, включая этот.
function ensureArchive(db) {
  for (const [name, ddl] of Object.entries(ARCHIVE_DDL)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${ddl})`);
    for (const op of ['UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_no_${op.toLowerCase()} BEFORE ${op} ON ${name}
        BEGIN SELECT RAISE(ABORT, '${name} is immutable evidence'); END`);
    }
    // REPLACE удаляет старую строку, не вызывая DELETE trigger при
    // recursive_triggers=OFF. Поэтому конфликтующий INSERT тоже запрещён.
    const keys=db.prepare(`PRAGMA table_info(${name})`).all().filter(c=>c.pk).map(c=>`${c.name}=NEW.${c.name}`).join(' AND ');
    const match=name===ARCHIVE?`(${keys}) OR fingerprint=NEW.fingerprint`:keys;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_no_replace BEFORE INSERT ON ${name}
      WHEN EXISTS(SELECT 1 FROM ${name} WHERE ${match})
      BEGIN SELECT RAISE(ABORT,'${name} is immutable evidence'); END`);
  }
}
const latestCycle = (db) => (archivePresent(db) ? db.prepare(`SELECT cycle_id id, kind FROM ${CYCLES} ORDER BY cycle_id DESC LIMIT 1`).get() || null : null);
const openCycle = (db, kind, at) => Number(db.prepare(`INSERT INTO ${CYCLES}(kind, created_at) VALUES(?, ?)`).run(kind, at).lastInsertRowid);
function archiver(db, at) {
  const insert = db.prepare(`INSERT INTO ${ARCHIVE}(fingerprint,origin,first_cycle_id,company_code,platform,platform_post_id,${CURRENT.join(',')},archived_at)
    SELECT ${Array(7 + CURRENT.length).fill('?').join(',')} WHERE NOT EXISTS(SELECT 1 FROM ${ARCHIVE} WHERE fingerprint=?)`);
  const find = db.prepare(`SELECT archive_id FROM ${ARCHIVE} WHERE fingerprint=?`);
  const link = db.prepare(`INSERT INTO ${CYCLE_ROWS}(cycle_id, archive_id) SELECT ?, ?
    WHERE NOT EXISTS(SELECT 1 FROM ${CYCLE_ROWS} WHERE cycle_id=? AND archive_id=?)`);
  const owner = db.prepare('SELECT company_code, platform, platform_post_id FROM social_posts WHERE id=?');
  // Одинаковое наблюдение хранится один раз; участие в каждом цикле фиксируется отдельной связью.
  return (cycleId, origin, row) => {
    const post = owner.get(row.post_id) || {};
    const fp = fingerprint(origin,{...row,...post},[...(origin === 'period_row' ? CURRENT : BASE),'company_code','platform','platform_post_id']);
    insert.run(fp, origin, cycleId, post.company_code ?? null, post.platform ?? null, post.platform_post_id ?? null,
      ...CURRENT.map((column) => (origin === 'legacy_write' && column === 'period' ? null : row[column] ?? null)), at,fp);
    const archiveId=find.get(fp).archive_id;link.run(cycleId,archiveId,cycleId,archiveId);
  };
}
const unanimous = (group, column, fallback) => (group.every((row) => row[column] === group[0][column]) ? group[0][column] : fallback);
// collected_at — самое позднее время снятия группы: устаревшая запись ограждённого писателя проекцию не вытеснит.
const mixedProjection = (group) => ({ post_id: group[0].post_id, date: group[0].date, metric: group[0].metric, value: null,
  unit: unanimous(group, 'unit', MIXED_UNIT), source_field: MIXED_SOURCE, completeness: 'unknown', provider: unanimous(group, 'provider', MIXED_PROVIDER),
  collected_at: group.reduce((max, row) => (row.collected_at > max ? row.collected_at : max), group[0].collected_at), run_id: null });

function swap(db, orphans, expectedRows, step) {
  db.exec(`DROP TABLE ${TABLE}`);
  db.exec(`ALTER TABLE ${REBUILD} RENAME TO ${TABLE}`);
  step('swapped');
  if (db.prepare(`SELECT COUNT(*) n FROM ${TABLE}`).get().n !== expectedRows || orphanPosts(db, TABLE) !== orphans) {
    throw failure('VERIFY_FAILED', 'social_post_metrics: число строк или набор строк без поста изменились при пересборке');
  }
}

function rollbackBody(db, { at, step }) {
  const shape = metricsShape(db);
  archivePresent(db);
  if (shape !== 'current') return { changed: false, state: shape === 'absent' ? 'absent' : 'legacy' };
  const orphans = orphanPosts(db, TABLE);
  ensureArchive(db);
  const cycleId = openCycle(db, 'rollback', at), archive = archiver(db, at), groups = new Map();
  const rows = db.prepare(`SELECT ${CURRENT.join(',')} FROM ${TABLE} ORDER BY post_id, date, metric, period`).all();
  for (const row of rows) {
    archive(cycleId, 'period_row', row);
    if (!groups.has(key3(row))) groups.set(key3(row), []);
    groups.get(key3(row)).push(row);
  }
  step('archived');
  db.exec(legacyDdl(REBUILD));
  const insert = inserter(db, REBUILD, BASE);
  for (const group of groups.values()) insert(group.length === 1 ? group[0] : mixedProjection(group));
  // Отпечаток берётся с уже записанной строки: так он совпадёт с тем, что позже прочитается из таблицы.
  const project = db.prepare(`INSERT INTO ${PROJECTIONS}(cycle_id,post_id,date,metric,kind,periods,fingerprint) VALUES(?,?,?,?,?,?,?)`);
  let mixed = 0;
  for (const legacy of db.prepare(`SELECT ${BASE.join(',')} FROM ${REBUILD}`).all()) {
    const group = groups.get(key3(legacy));
    if (group.length > 1) mixed += 1;
    project.run(cycleId, legacy.post_id, legacy.date, legacy.metric, group.length > 1 ? 'mixed' : 'exact',
      JSON.stringify(group.map((row) => row.period)), fingerprint('legacy', legacy, BASE));
  }
  step('projected');
  swap(db, orphans, groups.size, step);
  if (db.prepare(`SELECT COUNT(*) n FROM ${CYCLE_ROWS} WHERE cycle_id=?`).get(cycleId).n !== rows.length) {
    throw failure('VERIFY_FAILED', 'архив отката содержит не все строки');
  }
  return { changed: true, state: 'rolled_back', cycleId, archived: rows.length, projected: groups.size, mixed };
}

function restore(db, rollbackId, legacy, at) {
  const forwardId = openCycle(db, 'forward', at);
  const projections = new Map(db.prepare(`SELECT post_id, date, metric, fingerprint FROM ${PROJECTIONS} WHERE cycle_id=?`)
    .all(rollbackId).map((row) => [key3(row), row.fingerprint]));
  const archived = db.prepare(`SELECT a.* FROM ${ARCHIVE} a JOIN ${CYCLE_ROWS} c ON c.archive_id=a.archive_id
    WHERE c.cycle_id=? ORDER BY a.post_id, a.date, a.metric, a.period`).all(rollbackId);
  const owner = db.prepare('SELECT company_code, platform, platform_post_id FROM social_posts WHERE id=?');
  const present = new Set(legacy.map(key3)), live = new Map(), conflicts = [];
  let skippedDeleted = 0;
  for (const row of archived) {
    if (!present.has(key3(row))) { skippedDeleted += 1; continue; }
    const post = owner.get(row.post_id) || {};
    if ((post.company_code ?? null) !== row.company_code || (post.platform ?? null) !== row.platform || (post.platform_post_id ?? null) !== row.platform_post_id) {
      throw failure('TENANT_MISMATCH', 'пост архивной строки принадлежит другому владельцу: восстановление остановлено');
    }
    live.set(key4(row), { ...pick(row, CURRENT), origin: 'archive' });
  }
  const archive = archiver(db, at), writes = legacy.filter((row) => projections.get(key3(row)) !== fingerprint('legacy', row, BASE));
  for (const row of writes) {
    archive(forwardId, 'legacy_write', row);
    const candidate = { ...pick(row, BASE), period: 'unknown' }, previous = live.get(key4(candidate));
    if (previous) {
      const kept = candidate.collected_at >= previous.collected_at ? 'legacy_write' : 'archive';
      conflicts.push({ postId: row.post_id, date: row.date, metric: row.metric, kept });
      if (kept === 'archive') continue;
    }
    live.set(key4(candidate), { ...candidate, origin: 'legacy' });
  }
  const rows = [...live.values()];
  return { rows, stats: { state: 'restored', rollbackCycle: rollbackId, cycleId: forwardId,
    restored: rows.filter((row) => row.origin === 'archive').length, legacyWrites: writes.length, conflicts, skippedDeleted } };
}

function ensureBody(db, { at, step }) {
  const shape = metricsShape(db), latest = latestCycle(db);
  // Откат без возврата, а таблица уже новая: её перенёс кто-то другой (например, встроенная миграция). Данные не трогаем — сигнал координатору.
  const pending = latest?.kind === 'rollback' ? { pendingRollbackCycle: latest.id } : {};
  if (shape === 'absent') { db.exec(currentDdl(TABLE)); return { changed: true, state: 'created', ...pending }; }
  if (shape === 'current') return { changed: false, state: 'current', ...pending };
  if (latest && !(latest.kind === 'rollback' && shape === 'legacy')) {
    throw failure('STATE_MISMATCH', 'прежняя таблица не соответствует последнему циклу отката: периоды не выдумываются');
  }
  const orphans = orphanPosts(db, TABLE);
  const legacy = db.prepare(`SELECT ${(shape === 'legacy_period' ? CURRENT : BASE).join(',')} FROM ${TABLE} ORDER BY post_id, date, metric`).all();
  // Без отката — прежний перенос social-stats.js: период неизвестен, значения и происхождение без изменений.
  const { rows, stats } = latest ? restore(db, latest.id, legacy, at)
    : { rows: legacy.map((row) => ({ ...row, period: row.period === undefined || row.period === null || row.period === '' ? 'unknown' : row.period })), stats: { state: 'migrated' } };
  db.exec(currentDdl(REBUILD));
  const insert = inserter(db, REBUILD, CURRENT);
  for (const row of rows) insert(row);
  step('copied');
  swap(db, orphans, rows.length, step);
  return { changed: true, ...stats, rows: rows.length };
}

function owned(db, options, body) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw failure('INVALID_DATABASE', 'нужно открытое соединение SQLite');
  const { now = Date.now, onStep = null } = options || {};
  if (db.isTransaction !== false || db.inTransaction === true) {
    throw failure('EXTERNAL_TRANSACTION', 'миграция социальной схемы владеет своей транзакцией: внешняя транзакция активна');
  }
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1;
  if (foreignKeys) db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body(db, { at: new Date(now()).toISOString(), step: (name) => onStep?.(name) });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite уже закрыл транзакцию */ }
      throw error;
    }
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys=ON');
  }
}

/* Прямой перенос (идемпотентно): нет таблицы — создать новую; прежняя без отката — period unknown;
   прежняя после отката — точное восстановление архива плюс реальные записи прежнего писателя. */
const ensureSocialPostPeriodSchema = (db, options) => owned(db, options, ensureBody);
/* Офлайн-откат (идемпотентно): архив всех строк, проекция на тройной ключ для прежнего писателя.
   Сборщик нового MAX и прочие писатели нового ключа должны быть остановлены вызывающим. */
const rollbackSocialPostPeriodSchema = (db, options) => owned(db, options, rollbackBody);

module.exports = { ensureSocialPostPeriodSchema, rollbackSocialPostPeriodSchema, MIXED_SOURCE, TABLES };
