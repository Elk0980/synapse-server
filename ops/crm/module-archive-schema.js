'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

const ARCHIVE_VERSION = 'module-archive-v1';
const PREFIX = 'module_archive_';
const source = (database, tables, writers) => ({database, tables, writers});
// Это карта исходного кода, а не утверждение о состоянии живых баз или назначенных людях.
const MODULES = [
  ['sites', 'Сайты', 'Создавать и поддерживать сайты проектов.', 'Работающий сайт с актуальным содержимым.', [
    source('content.sqlite', ['documents', 'managed_sites', 'site_migrations'], ['ops/content/server.js', 'ops/content/site-store.js'])]],
  ['content-factory', 'Контент-завод', 'Готовить, согласовывать и выпускать контент.', 'Согласованный и опубликованный контент проекта.', [
    source('crm.sqlite', ['autoposting_posts', 'autoposting_reviews', 'autoposting_platform_reviews', 'autoposting_review_tasks'], ['ops/crm/autoposting.js', 'ops/crm/autoposting-review-tasks.js', 'ops/crm/studio-content-plan.js', 'ops/crm/media-mentor-transfer.js']),
    source('content.sqlite', ['telegram_source_chats', 'telegram_source_items', 'content_review_reminder_runs', 'content_review_reminder_items'], ['ops/content/telegram-sources.js', 'ops/content/content-review-reminders.js'])]],
  ['analytics', 'Аналитика', 'Проверять результаты работы по данным проектов.', 'Проверяемый отчёт о результатах проекта.', [
    source('crm.sqlite', ['external_stats', 'social_accounts', 'social_snapshots', 'social_posts', 'social_post_metrics', 'social_collect_runs'], ['ops/crm/server.js', 'ops/crm/social-stats.js'])]],
  ['advertising', 'Реклама', 'Вести историю решений и результатов рекламы.', 'Проверяемые результаты рекламной работы.', []],
  ['maps', 'Карты', 'Вести присутствие и отзывы на картах.', 'Актуальное присутствие проекта и обработанные отзывы.', [
    source('crm.sqlite', ['platform_demand_settings', 'platform_demand_datasets', 'platform_demand_checks', 'platform_demand_categories', 'company_reviews', 'company_review_platforms', 'company_review_events'], ['ops/crm/platform-demand.js', 'ops/crm/reviews.js'])]],
  ['crm', 'CRM', 'Вести задачи и работу с клиентами проектов.', 'Учтённые задачи и подтверждённые результаты работы.', [
    source('crm.sqlite', ['tasks', 'task_coordination', 'task_comments', 'agents', 'agent_sessions'], ['ops/crm/server.js', 'ops/crm/task-coordination.js', 'ops/crm/task-dispatch.js'])]],
  ['chat-hugh', 'Чат и Хью', 'Сохранять переписку и результаты помощи по проектам.', 'Сохранённая переписка и проверяемые результаты помощи.', [
    source('content.sqlite', ['project_chat_messages', 'project_chat_tasks', 'project_chat_task_notes', 'task_dispatch_links', 'owner_private_messages', 'client_dialog_messages'], ['ops/content/project-chat.js', 'ops/content/task-dispatch-worker.js', 'ops/content/owner-private-chat.js', 'ops/content/client-dialogs.js']),
    source('chat.sqlite', ['conversations', 'messages', 'client_tasks', 'client_task_comments', 'client_notifications'], ['ops/chat/server.js']),
    source('hugh-runtime.sqlite', ['reply_jobs', 'login_state', 'limit_state'], ['ops/hugh-runtime/job-store.js'])]],
].map(([code, name, purpose, final_product, sources]) => Object.freeze({
  code, name, purpose, final_product, responsible: '', data_sources: JSON.stringify(sources),
}));

const TABLE_SQL = `
CREATE TABLE module_archive_modules (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL,
  final_product TEXT NOT NULL, responsible TEXT NOT NULL DEFAULT '',
  data_sources TEXT NOT NULL CHECK(json_valid(data_sources) AND json_type(data_sources)='array')
);
CREATE TABLE module_archive_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_code TEXT NOT NULL REFERENCES module_archive_modules(code),
  project_code TEXT NOT NULL CHECK(length(project_code) BETWEEN 1 AND 64 AND project_code NOT GLOB '*[^a-z0-9_-]*' AND substr(project_code,1,1) GLOB '[a-z0-9]'),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('tried','succeeded','failed','report','decision','next_step')),
  text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 10000),
  links_json TEXT NOT NULL CHECK(json_valid(links_json) AND json_type(links_json)='array'),
  task_id INTEGER REFERENCES tasks(id),
  supersedes_id INTEGER REFERENCES module_archive_entries(id) CHECK(supersedes_id IS NULL OR supersedes_id<>id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  owner_id INTEGER NOT NULL CHECK(typeof(owner_id)='integer' AND owner_id>0),
  client_ref TEXT NOT NULL CHECK(length(trim(client_ref)) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,client_ref)
);
CREATE TABLE module_archive_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL CHECK(operation IN ('list','read','write')),
  module_code TEXT REFERENCES module_archive_modules(code),
  project_code TEXT,
  entry_id INTEGER REFERENCES module_archive_entries(id),
  session_id TEXT REFERENCES agent_sessions(id),
  agent_id INTEGER REFERENCES agents(id),
  owner_id INTEGER NOT NULL CHECK(typeof(owner_id)='integer' AND owner_id>0),
  created_at TEXT NOT NULL
);
CREATE TABLE module_archive_migrations (
  version TEXT PRIMARY KEY, applied_at TEXT NOT NULL,
  backup_path TEXT, backup_sha256 TEXT,
  CHECK((backup_path IS NULL AND backup_sha256 IS NULL) OR
    (backup_path IS NOT NULL AND backup_sha256 IS NOT NULL AND length(backup_sha256)=64 AND backup_sha256 NOT GLOB '*[^a-f0-9]*'))
);
CREATE INDEX module_archive_entries_scope_idx ON module_archive_entries(module_code,project_code,id);
CREATE INDEX module_archive_entries_task_idx ON module_archive_entries(task_id,id);
CREATE INDEX module_archive_entries_session_idx ON module_archive_entries(session_id,id);
CREATE INDEX module_archive_access_owner_idx ON module_archive_access(owner_id,id);
CREATE INDEX module_archive_access_entry_idx ON module_archive_access(entry_id,id);
`;
const IMMUTABLE_SQL = ['modules', 'entries', 'access', 'migrations'].map(name => `
CREATE TRIGGER module_archive_${name}_no_update BEFORE UPDATE ON module_archive_${name}
  BEGIN SELECT RAISE(ABORT,'Immutable module archive'); END;
CREATE TRIGGER module_archive_${name}_no_delete BEFORE DELETE ON module_archive_${name}
  BEGIN SELECT RAISE(ABORT,'Immutable module archive'); END;`).join('\n');
// SQLite REPLACE может удалить прежнюю строку без DELETE trigger. Проверяем конфликт до INSERT.
const NO_REPLACE_SQL = `
CREATE TRIGGER module_archive_modules_no_replace BEFORE INSERT ON module_archive_modules
  WHEN EXISTS(SELECT 1 FROM module_archive_modules WHERE code=NEW.code)
  BEGIN SELECT RAISE(ABORT,'Immutable module archive'); END;
CREATE TRIGGER module_archive_entries_no_replace BEFORE INSERT ON module_archive_entries
  WHEN EXISTS(SELECT 1 FROM module_archive_entries WHERE id=NEW.id OR (owner_id=NEW.owner_id AND client_ref=NEW.client_ref))
  BEGIN SELECT RAISE(ABORT,'Immutable module archive'); END;
CREATE TRIGGER module_archive_access_no_replace BEFORE INSERT ON module_archive_access
  WHEN EXISTS(SELECT 1 FROM module_archive_access WHERE id=NEW.id)
  BEGIN SELECT RAISE(ABORT,'Immutable module archive'); END;
CREATE TRIGGER module_archive_migrations_no_replace BEFORE INSERT ON module_archive_migrations
  WHEN EXISTS(SELECT 1 FROM module_archive_migrations WHERE version=NEW.version)
  BEGIN SELECT RAISE(ABORT,'Immutable module archive'); END;
`;
const SCHEMA_SQL = TABLE_SQL + IMMUTABLE_SQL + NO_REPLACE_SQL;

function fail(message) { throw new Error(`Архив модулей: ${message}`); }
function quote(name) { return `"${String(name).replaceAll('"', '""')}"`; }
function archiveObject(row) { return row.name.startsWith(PREFIX) || row.tbl_name.startsWith(PREFIX); }
function schemaRows(db) {
  return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
}
let expectedSchema;
function archiveSchema() {
  if (!expectedSchema) {
    const memory = new DatabaseSync(':memory:');
    try {
      memory.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY); CREATE TABLE agents(id INTEGER PRIMARY KEY); CREATE TABLE agent_sessions(id TEXT PRIMARY KEY);');
      memory.exec(SCHEMA_SQL);
      expectedSchema = JSON.stringify(schemaRows(memory).filter(archiveObject));
    } finally { memory.close(); }
  }
  return expectedSchema;
}

function encode(value) {
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['integer', String(value)];
  if (typeof value === 'number') return ['real', Object.is(value, -0) ? '-0' : String(value)];
  if (ArrayBuffer.isView(value)) return ['blob', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
  return ['text', value];
}
function snapshotLegacyState(db) {
  const schema = schemaRows(db).filter(row => !archiveObject(row) && row.name !== 'sqlite_sequence');
  const tables = schema.filter(row => row.type === 'table');
  const tableKinds = new Map(db.prepare('PRAGMA main.table_list').all()
    .filter(row => row.schema === 'main').map(row => [row.name, row]));
  const rows = tables.map(({name}) => {
    const kind = tableKinds.get(name);
    if (!kind) fail(`не удалось определить вид таблицы ${name}`);
    let select = '*';
    if (kind.wr === 0) {
      // SELECT * не включает hidden rowid, который используется некоторыми прежними очередями.
      // Имена rowid/_rowid_/oid могут быть настоящими колонками: выбираем свободное имя.
      const columns = db.prepare(`PRAGMA main.table_xinfo(${quote(name)})`).all();
      const names = new Set(columns.map(column => column.name.toLowerCase()));
      let rowid = ['rowid', '_rowid_', 'oid'].find(alias => !names.has(alias));
      if (!rowid) {
        const primary = columns.filter(column => column.pk > 0);
        // INTEGER PRIMARY KEY DESC имеет отдельный pk-index и не является alias rowid.
        const hasPrimaryIndex = db.prepare(`PRAGMA main.index_list(${quote(name)})`).all().some(index => index.origin === 'pk');
        if (primary.length !== 1 || primary[0].type.trim().toUpperCase() !== 'INTEGER' || hasPrimaryIndex) {
          fail(`невозможно проверить hidden rowid таблицы ${name}: все его имена заняты, INTEGER PRIMARY KEY alias отсутствует`);
        }
        rowid = primary[0].name;
      }
      let alias = '__module_archive_hidden_rowid__';
      while (names.has(alias.toLowerCase())) alias += '_';
      select += `,${quote(rowid)} AS ${quote(alias)}`;
    }
    const statement = db.prepare(`SELECT ${select} FROM ${quote(name)}`);
    statement.setReadBigInts(true);
    const hashes = statement.all().map(row => crypto.createHash('sha256')
      .update(JSON.stringify(Object.entries(row).map(([key, value]) => [key, encode(value)]))).digest('hex')).sort();
    return {name, count: hashes.length, sha256: crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
  });
  let sequences = [];
  if (schemaRows(db).some(row => row.name === 'sqlite_sequence')) {
    const sequenceRows = db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name');
    sequenceRows.setReadBigInts(true);
    sequences = sequenceRows.all().filter(row => !row.name.startsWith(PREFIX)).map(row => ({name: row.name, seq: String(row.seq)}));
  }
  return JSON.stringify({schema, rows, sequences,
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    applicationId: db.prepare('PRAGMA application_id').get().application_id});
}
function assertDatabaseHealthy(db) {
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0].integrity_check !== 'ok') fail('integrity_check не пройден');
  if (db.prepare('PRAGMA foreign_key_check').all().length) fail('foreign_key_check не пройден');
}
function assertAbsoluteRegular(file, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail(`${label}: нужен абсолютный путь`);
  let current = path.resolve(file);
  for (;;) {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) fail(`${label}: символические ссылки запрещены`);
    if (current === path.resolve(file) && !info.isFile()) fail(`${label}: нужен обычный файл`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync(file);
}
function pathExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function readBackupSha256(file) {
  assertAbsoluteRegular(file, 'Резервная копия');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const initial = fs.fstatSync(descriptor);
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
    const final = fs.lstatSync(file);
    if (!final.isFile() || final.isSymbolicLink() || initial.dev !== final.dev || initial.ino !== final.ino ||
        initial.size !== final.size || initial.mtimeMs !== final.mtimeMs) fail('резервная копия изменилась при чтении');
    return digest.digest('hex');
  } finally { fs.closeSync(descriptor); }
}
function checkPrerequisites(db) {
  for (const [name, required] of [['tasks', ['id']], ['agents', ['id']], ['agent_sessions', ['id', 'agent_id', 'owner_id']]]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) fail(`нет обязательной таблицы ${name}`);
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    if (required.some(column => !columns.some(row => row.name === column)) || !columns.some(row => row.name === 'id' && row.pk === 1)) {
      fail(`неожиданная схема обязательной таблицы ${name}`);
    }
  }
  if (db.prepare('PRAGMA database_list').all().some(row => !['main', 'temp'].includes(row.name))) fail('подключённые дополнительные базы запрещены');
}
function verifyArchiveSchema(db) {
  const actual = schemaRows(db).filter(archiveObject);
  if (JSON.stringify(actual) !== archiveSchema()) fail('частичная или неожиданная схема архива; автоматическое исправление запрещено');
  const migrations = db.prepare('SELECT * FROM module_archive_migrations').all();
  if (migrations.length !== 1 || migrations[0].version !== ARCHIVE_VERSION ||
      !Number.isFinite(Date.parse(migrations[0].applied_at))) fail('неожиданный маркер миграции');
  const modules = db.prepare('SELECT * FROM module_archive_modules ORDER BY code').all();
  if (JSON.stringify(modules) !== JSON.stringify([...MODULES].sort((a, b) => a.code.localeCompare(b.code)))) fail('неожиданные исходные карточки модулей');
  return migrations[0];
}
function verifyBackup(db, backupPath, backupSha256, baseline) {
  if (typeof backupSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(backupSha256)) fail('нужен SHA-256 согласованной резервной копии');
  const realBackup = assertAbsoluteRegular(backupPath, 'Резервная копия');
  const realDatabase = assertAbsoluteRegular(db.location(), 'Исходная база');
  const original = fs.statSync(realDatabase), backup = fs.statSync(realBackup);
  if (realBackup === realDatabase || (original.dev === backup.dev && original.ino === backup.ino)) fail('копия совпадает с исходной базой');
  if (['-wal', '-shm', '-journal'].some(suffix => pathExists(backupPath + suffix))) fail('резервная копия имеет незавершённые sidecar-файлы');
  if (readBackupSha256(backupPath) !== backupSha256) fail('SHA-256 резервной копии не совпадает');
  const copy = new DatabaseSync(realBackup, {readOnly: true});
  try {
    assertDatabaseHealthy(copy);
    if (schemaRows(copy).some(archiveObject) || snapshotLegacyState(copy) !== baseline) fail('резервная копия не соответствует текущей базе');
  } finally { copy.close(); }
}

function installArchiveSchema(db, {backupPath = null, backupSha256 = null, now = () => Date.now()} = {}) {
  if (!db || typeof db.exec !== 'function' || typeof now !== 'function') fail('некорректные параметры установки');
  if (db.isTransaction) fail('установка требует собственной исключительной транзакции');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('BEGIN EXCLUSIVE');
  try {
    checkPrerequisites(db);
    if (schemaRows(db).some(archiveObject)) {
      const marker = verifyArchiveSchema(db);
      assertDatabaseHealthy(db);
      db.exec('COMMIT');
      return {version: ARCHIVE_VERSION, installed: false, backupPath: marker.backup_path, backupSha256: marker.backup_sha256};
    }
    assertDatabaseHealthy(db);
    const baseline = snapshotLegacyState(db);
    if (db.location()) verifyBackup(db, backupPath, backupSha256, baseline);
    else if (backupPath !== null || backupSha256 !== null) fail('для memory-базы резервная копия не принимается');
    const timestamp = new Date(now()).toISOString();
    db.exec(SCHEMA_SQL);
    const insert = db.prepare('INSERT INTO module_archive_modules(code,name,purpose,final_product,responsible,data_sources) VALUES(?,?,?,?,?,?)');
    for (const item of MODULES) insert.run(item.code, item.name, item.purpose, item.final_product, item.responsible, item.data_sources);
    db.prepare('INSERT INTO module_archive_migrations(version,applied_at,backup_path,backup_sha256) VALUES(?,?,?,?)')
      .run(ARCHIVE_VERSION, timestamp, backupPath, backupSha256);
    verifyArchiveSchema(db);
    assertDatabaseHealthy(db);
    if (snapshotLegacyState(db) !== baseline) fail('изменились существующие таблицы, схема или строки; транзакция отменена');
    if (db.location() && readBackupSha256(backupPath) !== backupSha256) fail('резервная копия изменилась до COMMIT');
    db.exec('COMMIT');
    return {version: ARCHIVE_VERSION, installed: true, backupPath, backupSha256};
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {ARCHIVE_VERSION, MODULES, installArchiveSchema, verifyArchiveSchema,
  snapshotLegacyState, assertDatabaseHealthy, assertAbsoluteRegular, readBackupSha256, pathExists};
