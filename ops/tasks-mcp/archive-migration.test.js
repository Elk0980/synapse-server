'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const {ARCHIVE_VERSION, installArchiveSchema, snapshotLegacyState, readBackupSha256,
  verifyArchiveSchema} = require('../crm/module-archive-schema');
const {migrateArchiveDatabase, argumentsFrom} = require('../crm/module-archive-migrate');

const BASE = `PRAGMA foreign_keys=ON;
  CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,company_code TEXT NOT NULL DEFAULT 'synapse-business');
  CREATE TABLE agents(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE);
  CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,agent_id INTEGER NOT NULL REFERENCES agents(id),owner_id INTEGER NOT NULL);
  CREATE TABLE old_details(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL REFERENCES tasks(id),payload BLOB,note TEXT,amount REAL);
  CREATE INDEX old_details_task_idx ON old_details(task_id);
  CREATE TRIGGER old_tasks_keep_title BEFORE UPDATE ON tasks WHEN NEW.title='invalid'
    BEGIN SELECT RAISE(ABORT,'existing trigger'); END;
  INSERT INTO tasks(title) VALUES('Прежняя задача');
  INSERT INTO agents(name) VALUES('Тестовый исполнитель');
  INSERT INTO agent_sessions VALUES('session-test',1,1);
  INSERT INTO old_details(task_id,payload,note,amount) VALUES(1,x'0001ff',NULL,1.25);
  INSERT INTO old_details(id,task_id,payload,note,amount) VALUES(400,1,x'80','Прежний текст',0.0);
  DELETE FROM old_details WHERE id=400;
  PRAGMA user_version=9; PRAGMA application_id=123;`;

function fixture(t, {file = false, wal = false} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-archive-migration-'));
  const databasePath = path.join(directory, 'crm.sqlite');
  const backupPath = path.join(directory, 'before.sqlite');
  const db = new DatabaseSync(file ? databasePath : ':memory:');
  db.exec(BASE);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  let open = true;
  const close = () => { if (open) {db.close(); open = false;} };
  t.after(() => {close(); fs.rmSync(directory, {recursive: true, force: true});});
  return {db, directory, databasePath, backupPath, close};
}
function archiveCount(db) {
  return db.prepare("SELECT count(*) n FROM sqlite_master WHERE substr(name,1,15)='module_archive_' OR substr(tbl_name,1,15)='module_archive_'").get().n;
}
function addEntry(db, {clientRef = 'fixture-entry', type = 'tried', session = 'session-test', agent = 1} = {}) {
  return db.prepare(`INSERT INTO module_archive_entries(module_code,project_code,entry_type,text,links_json,
    task_id,session_id,agent_id,owner_id,client_ref,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('crm', 'synapse-business', type, 'Проверенная запись', '[]', 1, session, agent, 1, clientRef, 'a'.repeat(64), '2026-11-03T12:00:00.000Z');
}

test('additive memory migration preserves original schema, rows, types, sequence and schema version', t => {
  const f = fixture(t), before = snapshotLegacyState(f.db);
  assert.equal(installArchiveSchema(f.db, {now: () => 1793707200000}).installed, true);
  assert.equal(snapshotLegacyState(f.db), before);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(f.db.prepare('SELECT count(*) n FROM module_archive_modules').get().n, 7);
  assert.deepEqual(f.db.prepare('SELECT DISTINCT responsible FROM module_archive_modules').all().map(row => row.responsible), ['']);
  assert.equal(f.db.prepare("SELECT data_sources FROM module_archive_modules WHERE code='advertising'").get().data_sources, '[]');
  assert.throws(() => f.db.prepare("UPDATE tasks SET title='invalid' WHERE id=1").run(), /existing trigger/);
  assert.throws(() => f.db.prepare('INSERT INTO old_details(task_id) VALUES(99)').run(), /FOREIGN KEY/);
  assert.equal(f.db.prepare('INSERT INTO old_details(task_id) VALUES(1)').run().lastInsertRowid, 401);
});

test('exact repeat is no-op; existing archive entries and marker survive', t => {
  const f = fixture(t);
  installArchiveSchema(f.db);
  addEntry(f.db);
  const before = f.db.prepare('SELECT * FROM module_archive_migrations').get();
  assert.equal(installArchiveSchema(f.db, {now: () => 0}).installed, false);
  assert.deepEqual(f.db.prepare('SELECT * FROM module_archive_migrations').get(), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM module_archive_entries').get().n, 1);
});

test('raw SQL UPDATE, DELETE and REPLACE cannot change any immutable archive family', t => {
  const f = fixture(t);
  installArchiveSchema(f.db);
  addEntry(f.db);
  f.db.prepare("INSERT INTO module_archive_access(operation,module_code,project_code,entry_id,session_id,agent_id,owner_id,created_at) VALUES('read','crm','synapse-business',1,'session-test',1,1,'2026-11-03')").run();
  for (const table of ['modules', 'entries', 'access', 'migrations']) {
    assert.throws(() => f.db.exec(`DELETE FROM module_archive_${table}`), /Immutable module archive/);
    const column = table === 'modules' ? 'name' : table === 'entries' ? 'text' : table === 'access' ? 'operation' : 'applied_at';
    assert.throws(() => f.db.exec(`UPDATE module_archive_${table} SET ${column}=${column}`), /Immutable module archive/);
    assert.throws(() => f.db.exec(`INSERT OR REPLACE INTO module_archive_${table} SELECT * FROM module_archive_${table}`), /Immutable module archive/);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM module_archive_entries').get().n, 1);
});

test('FKs and checks reject invalid entry metadata without modifying old business rows', t => {
  const f = fixture(t); installArchiveSchema(f.db);
  const before = snapshotLegacyState(f.db);
  for (const input of [{type: 'unknown'}, {session: 'missing'}, {agent: 99}]) assert.throws(() => addEntry(f.db, input));
  assert.equal(snapshotLegacyState(f.db), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM module_archive_entries').get().n, 0);
});

test('partial archive, altered trigger and extra archive objects are refused without repair', t => {
  const partial = fixture(t);
  partial.db.exec('CREATE TABLE module_archive_entries(id INTEGER PRIMARY KEY)');
  assert.throws(() => installArchiveSchema(partial.db), /частичная|неожиданная/);
  assert.equal(archiveCount(partial.db), 1);
  const altered = fixture(t); installArchiveSchema(altered.db);
  altered.db.exec('DROP TRIGGER module_archive_entries_no_update');
  assert.throws(() => installArchiveSchema(altered.db), /частичная|неожиданная/);
  const extra = fixture(t); installArchiveSchema(extra.db);
  extra.db.exec('CREATE INDEX surprise_archive_index ON module_archive_entries(text)');
  assert.throws(() => installArchiveSchema(extra.db), /частичная|неожиданная/);
});

test('preconditions and invalid clock abort before any committed DDL', t => {
  const f = fixture(t); f.db.exec('DROP TABLE old_details; DROP TABLE tasks');
  assert.throws(() => installArchiveSchema(f.db), /обязательной таблицы tasks/);
  assert.equal(archiveCount(f.db), 0);
  const invalidClock = fixture(t);
  assert.throws(() => installArchiveSchema(invalidClock.db, {now: () => NaN}));
  assert.equal(archiveCount(invalidClock.db), 0);
});

test('preservation guard rolls back DDL and old rows if an installation fault changes legacy data', t => {
  const f = fixture(t), before = snapshotLegacyState(f.db), execute = f.db.exec;
  f.db.exec = function(sql) {
    const result = execute.call(this, sql);
    if (sql.includes('CREATE TABLE module_archive_modules')) execute.call(this, "UPDATE tasks SET title='Ошибка установщика' WHERE id=1");
    return result;
  };
  assert.throws(() => installArchiveSchema(f.db), /изменились существующие/);
  f.db.exec = execute;
  assert.equal(archiveCount(f.db), 0);
  assert.equal(snapshotLegacyState(f.db), before);
});

test('file installation without verified backup, missing backup, wrong SHA or stale backup commits zero DDL', t => {
  const f = fixture(t, {file: true});
  assert.throws(() => installArchiveSchema(f.db), /SHA-256/);
  assert.throws(() => installArchiveSchema(f.db, {backupPath: f.backupPath, backupSha256: 'a'.repeat(64)}));
  f.db.prepare('VACUUM INTO ?').run(f.backupPath);
  assert.throws(() => installArchiveSchema(f.db, {backupPath: f.backupPath, backupSha256: 'a'.repeat(64)}), /SHA-256/);
  const hash = readBackupSha256(f.backupPath);
  f.db.prepare("UPDATE tasks SET title='Изменено после копии' WHERE id=1").run();
  assert.throws(() => installArchiveSchema(f.db, {backupPath: f.backupPath, backupSha256: hash}), /не соответствует/);
  assert.equal(archiveCount(f.db), 0);
});

test('rowid-only mismatch in an otherwise identical backup refuses archive installation before DDL', t => {
  const f = fixture(t, {file: true});
  f.db.exec("CREATE TABLE hidden_rows(value TEXT); INSERT INTO hidden_rows(rowid,value) VALUES(1,'первое'),(10,'второе')");
  f.db.prepare('VACUUM INTO ?').run(f.backupPath);
  const copy = new DatabaseSync(f.backupPath);
  try {
    copy.exec('UPDATE hidden_rows SET rowid=2 WHERE rowid=10');
    assert.deepEqual(copy.prepare('SELECT * FROM hidden_rows ORDER BY value').all(), f.db.prepare('SELECT * FROM hidden_rows ORDER BY value').all());
    assert.notEqual(snapshotLegacyState(copy), snapshotLegacyState(f.db));
  } finally {copy.close();}
  assert.throws(() => installArchiveSchema(f.db, {backupPath: f.backupPath, backupSha256: readBackupSha256(f.backupPath)}), /не соответствует/);
  assert.equal(archiveCount(f.db), 0);
  assert.deepEqual(f.db.prepare('SELECT rowid FROM hidden_rows ORDER BY rowid').all().map(row => row.rowid), [1, 10]);
});

test('rowid-only installation fault rolls back both archive DDL and hidden rowid change', t => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE hidden_rows(value TEXT); INSERT INTO hidden_rows(rowid,value) VALUES(1,'первое'),(10,'второе')");
  const before = snapshotLegacyState(f.db), execute = f.db.exec;
  f.db.exec = function(sql) {
    const result = execute.call(this, sql);
    if (sql.includes('CREATE TABLE module_archive_modules')) execute.call(this, 'UPDATE hidden_rows SET rowid=2 WHERE rowid=10');
    return result;
  };
  assert.throws(() => installArchiveSchema(f.db), /изменились существующие/);
  f.db.exec = execute;
  assert.equal(archiveCount(f.db), 0);
  assert.equal(snapshotLegacyState(f.db), before);
  assert.deepEqual(f.db.prepare('SELECT rowid FROM hidden_rows ORDER BY rowid').all().map(row => row.rowid), [1, 10]);
});

test('WITHOUT ROWID, text PK, real rowid column and snapshot alias collisions retain their actual identifiers', t => {
  const f = fixture(t, {file: true});
  f.db.exec(`CREATE TABLE no_rowid(id TEXT PRIMARY KEY,rowid TEXT,value TEXT) WITHOUT ROWID;
    INSERT INTO no_rowid VALUES('key','real column','данные');
    CREATE TABLE text_keys(id TEXT PRIMARY KEY,rowid TEXT,__module_archive_hidden_rowid__ TEXT,value TEXT);
    INSERT INTO text_keys(_rowid_,id,rowid,__module_archive_hidden_rowid__,value) VALUES(1,'a','своя колонка','не затереть','первое');`);
  const big = 9007199254740993n;
  f.db.prepare('INSERT INTO text_keys(_rowid_,id,rowid,__module_archive_hidden_rowid__,value) VALUES(?,?,?,?,?)')
    .run(big, 'b', 'другая колонка', 'также сохранить', 'второе');
  const before = snapshotLegacyState(f.db);
  const result = migrateArchiveDatabase({databasePath: f.databasePath, backupPath: f.backupPath, offlineConfirmation: 'CRM_STOPPED'});
  assert.equal(result.installed, true);
  assert.equal(snapshotLegacyState(f.db), before);
  const ids = f.db.prepare('SELECT _rowid_ AS hidden,rowid,__module_archive_hidden_rowid__ AS original FROM text_keys ORDER BY _rowid_');
  ids.setReadBigInts(true);
  assert.deepEqual(ids.all().map(row => [row.hidden, row.rowid, row.original]), [
    [1n, 'своя колонка', 'не затереть'], [big, 'другая колонка', 'также сохранить'],
  ]);
  assert.equal(f.db.prepare('SELECT rowid FROM no_rowid').get().rowid, 'real column');
});

test('all shadowed rowid names require a proven INTEGER PRIMARY KEY alias; otherwise fail conservatively', t => {
  const blocked = fixture(t);
  blocked.db.exec("CREATE TABLE all_hidden(rowid TEXT,_rowid_ TEXT,oid TEXT); INSERT INTO all_hidden VALUES('a','b','c')");
  assert.throws(() => installArchiveSchema(blocked.db), /невозможно проверить hidden rowid/);
  assert.equal(archiveCount(blocked.db), 0);
  const allowed = fixture(t);
  allowed.db.exec("CREATE TABLE with_integer_key(id INTEGER PRIMARY KEY,rowid TEXT,_rowid_ TEXT,oid TEXT); INSERT INTO with_integer_key VALUES(10,'a','b','c')");
  assert.equal(installArchiveSchema(allowed.db).installed, true);
  const descending = fixture(t);
  descending.db.exec('CREATE TABLE descending_key(id INTEGER PRIMARY KEY DESC,rowid TEXT,_rowid_ TEXT,oid TEXT)');
  assert.throws(() => installArchiveSchema(descending.db), /невозможно проверить hidden rowid/);
  assert.equal(archiveCount(descending.db), 0);
});

test('WAL committed data is present in consistent backup and old rows remain exact after reopen', t => {
  const f = fixture(t, {file: true, wal: true});
  f.db.prepare("INSERT INTO tasks(title) VALUES('Последняя WAL-запись')").run();
  assert.ok(fs.statSync(f.databasePath + '-wal').size > 0);
  const before = snapshotLegacyState(f.db);
  const result = migrateArchiveDatabase({databasePath: f.databasePath, backupPath: f.backupPath, offlineConfirmation: 'CRM_STOPPED'});
  assert.equal(result.installed, true);
  assert.equal(result.version, ARCHIVE_VERSION);
  assert.match(result.backupSha256, /^[a-f0-9]{64}$/);
  const copy = new DatabaseSync(f.backupPath, {readOnly: true});
  try {
    assert.equal(snapshotLegacyState(copy), before);
    assert.equal(copy.prepare('SELECT count(*) n FROM tasks').get().n, 2);
    assert.equal(archiveCount(copy), 0);
  } finally {copy.close();}
  f.close();
  const reopened = new DatabaseSync(f.databasePath);
  try {
    assert.equal(snapshotLegacyState(reopened), before);
    verifyArchiveSchema(reopened);
    assert.equal(installArchiveSchema(reopened).installed, false);
  } finally {reopened.close();}
  assert.equal(migrateArchiveDatabase({databasePath: f.databasePath, backupPath: f.backupPath, offlineConfirmation: 'CRM_STOPPED'}).installed, false);
});

test('busy writer blocks archive DDL and preserves backup and original rows', t => {
  const f = fixture(t, {file: true, wal: true});
  f.db.prepare('VACUUM INTO ?').run(f.backupPath);
  const hash = readBackupSha256(f.backupPath), second = new DatabaseSync(f.databasePath);
  try {
    second.exec('BEGIN IMMEDIATE');
    assert.throws(() => installArchiveSchema(f.db, {backupPath: f.backupPath, backupSha256: hash}), /locked/);
    assert.equal(archiveCount(f.db), 0);
    second.exec('ROLLBACK');
    assert.equal(readBackupSha256(f.backupPath), hash);
  } finally {if (second.isTransaction) second.exec('ROLLBACK'); second.close();}
});

test('CLI refuses existing backup, missing source, relative paths and unconfirmed live mode', t => {
  const f = fixture(t, {file: true});
  fs.writeFileSync(f.backupPath, 'existing backup sentinel');
  const original = fs.readFileSync(f.backupPath);
  assert.throws(() => migrateArchiveDatabase({databasePath: f.databasePath, backupPath: f.backupPath, offlineConfirmation: 'CRM_STOPPED'}), /занят/);
  assert.deepEqual(fs.readFileSync(f.backupPath), original);
  assert.throws(() => migrateArchiveDatabase({databasePath: f.databasePath, backupPath: f.backupPath}), /остановку/);
  assert.throws(() => migrateArchiveDatabase({databasePath: 'relative.sqlite', backupPath: f.backupPath, offlineConfirmation: 'CRM_STOPPED'}), /абсолютный/);
  const missing = path.join(f.directory, 'does-not-exist.sqlite');
  assert.throws(() => migrateArchiveDatabase({databasePath: missing, backupPath: f.backupPath, offlineConfirmation: 'CRM_STOPPED'}));
  assert.equal(fs.existsSync(missing), false);
  const empty = path.join(f.directory, 'empty.sqlite'); fs.writeFileSync(empty, '');
  assert.throws(() => migrateArchiveDatabase({databasePath: empty, backupPath: path.join(f.directory, 'new.sqlite'), offlineConfirmation: 'CRM_STOPPED'}), /не является/);
  assert.equal(fs.statSync(empty).size, 0);
  assert.equal(archiveCount(f.db), 0);
});

test('symlink source and backup paths are refused when the platform permits symlink creation', t => {
  const f = fixture(t, {file: true}), link = path.join(f.directory, 'linked.sqlite');
  try {fs.symlinkSync(f.databasePath, link, 'file');}
  catch (error) {if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Создание file symlink недоступно этому Windows-пользователю'); throw error;}
  assert.throws(() => migrateArchiveDatabase({databasePath: link, backupPath: f.backupPath, offlineConfirmation: 'CRM_STOPPED'}), /символические/);
  assert.throws(() => migrateArchiveDatabase({databasePath: f.databasePath, backupPath: link, offlineConfirmation: 'CRM_STOPPED'}), /занят/);
  assert.equal(archiveCount(f.db), 0);
});

test('backup corruption and foreign-key violations refuse installation without DDL', t => {
  const f = fixture(t, {file: true});
  fs.writeFileSync(f.backupPath, 'not SQLite');
  assert.throws(() => installArchiveSchema(f.db, {backupPath: f.backupPath, backupSha256: readBackupSha256(f.backupPath)}));
  assert.equal(archiveCount(f.db), 0);
  f.db.exec('PRAGMA foreign_keys=OFF; INSERT INTO old_details(task_id) VALUES(99); PRAGMA foreign_keys=ON');
  assert.throws(() => installArchiveSchema(f.db, {backupPath: f.backupPath, backupSha256: readBackupSha256(f.backupPath)}), /foreign_key_check/);
  assert.equal(archiveCount(f.db), 0);
});

test('CLI argument grammar rejects duplicate, unknown and missing inputs and runs only against synthetic DB', t => {
  const f = fixture(t, {file: true});
  for (const args of [[], ['--database'], ['--database', f.databasePath, '--database', f.databasePath], ['--unknown', 'x'], ['--database', '--backup']]) assert.throws(() => argumentsFrom(args));
  const command = spawnSync(process.execPath, [path.join(__dirname, '../crm/module-archive-migrate.js'),
    '--database', f.databasePath, '--backup', f.backupPath, '--offline-confirmation', 'CRM_STOPPED'], {encoding: 'utf8', windowsHide: true});
  assert.equal(command.status, 0, command.stderr);
  const result = JSON.parse(command.stdout);
  assert.equal(result.installed, true);
  assert.equal(result.backupSha256, crypto.createHash('sha256').update(fs.readFileSync(f.backupPath)).digest('hex'));
  const repeated = spawnSync(process.execPath, [path.join(__dirname, '../crm/module-archive-migrate.js'),
    '--database', f.databasePath, '--backup', f.backupPath, '--offline-confirmation', 'CRM_STOPPED'], {encoding: 'utf8', windowsHide: true});
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).installed, false);
  assert.equal(readBackupSha256(f.backupPath), result.backupSha256);
});
