'use strict';

// Только offline-инструмент. Флаг — заявление оператора, а не обнаружение остановленного сервиса.
// Оператор заранее останавливает CRM и всех писателей БД; эта команда не управляет контейнерами.
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {DatabaseSync} = require('node:sqlite');
const {installArchiveSchema, verifyArchiveSchema, assertDatabaseHealthy,
  assertAbsoluteRegular, readBackupSha256, pathExists} = require('./module-archive-schema');

function migrateArchiveDatabase({databasePath, backupPath, offlineConfirmation} = {}) {
  if (offlineConfirmation !== 'CRM_STOPPED') throw new Error('Нужно явно подтвердить остановку CRM и всех писателей: CRM_STOPPED');
  const realDatabase = assertAbsoluteRegular(databasePath, 'Исходная база');
  if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath) || backupPath.includes('\0')) throw new Error('Нужен абсолютный путь новой резервной копии');
  const identity = fs.statSync(realDatabase);
  const source = fs.openSync(realDatabase, 'r');
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(source, header, 0, 16, 0) !== 16 || header.toString('binary') !== 'SQLite format 3\0') throw new Error('Исходный файл не является существующей базой SQLite');
  } finally {fs.closeSync(source);}
  // mode=rw принципиален: SQLite не должен создать новую исходную БД при ошибке пути/исчезновении файла.
  const db = new DatabaseSync(pathToFileURL(realDatabase).href + '?mode=rw');
  let descriptor;
  try {
    const afterOpen = fs.statSync(realDatabase);
    if (identity.dev !== afterOpen.dev || identity.ino !== afterOpen.ino) throw new Error('Исходная база была заменена');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
    // Повтор установки не делает новую копию и не изменяет marker/schema.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE substr(name,1,15)='module_archive_' OR substr(tbl_name,1,15)='module_archive_'").get()) {
      verifyArchiveSchema(db);
      return installArchiveSchema(db);
    }
    let current = path.dirname(backupPath);
    for (;;) {
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог резервной копии должен быть обычным каталогом без символических ссылок');
      if (path.dirname(current) === current) break;
      current = path.dirname(current);
    }
    if (['', '-wal', '-shm', '-journal'].some(suffix => pathExists(backupPath + suffix))) throw new Error('Путь резервной копии уже занят; перезапись запрещена');
    assertDatabaseHealthy(db);
    // wx не даёт затереть существующий файл, включая пустой. VACUUM INTO допускает наш пустой файл.
    descriptor = fs.openSync(backupPath, 'wx', 0o600);
    const reserved = fs.fstatSync(descriptor);
    db.prepare('VACUUM INTO ?').run(backupPath);
    fs.fsyncSync(descriptor);
    const completed = fs.lstatSync(backupPath);
    if (!completed.isFile() || completed.isSymbolicLink() || completed.dev !== reserved.dev || completed.ino !== reserved.ino) throw new Error('Путь резервной копии был заменён');
    fs.closeSync(descriptor); descriptor = undefined;
    const backupSha256 = readBackupSha256(backupPath);
    // BEGIN EXCLUSIVE и сравнение всех прежних данных выполняет установщик. Изменение после
    // VACUUM INTO отменит установку до DDL. В WAL lock не доказывает остановку внешних процессов.
    return installArchiveSchema(db, {backupPath, backupSha256});
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    db.close();
  }
}

function argumentsFrom(argv) {
  const allowed = new Set(['--database', '--backup', '--offline-confirmation']);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || Object.hasOwn(result, key) || typeof value !== 'string' || value.startsWith('--')) throw new Error('Нужны --database ABS_PATH --backup ABS_PATH --offline-confirmation CRM_STOPPED');
    result[key] = value;
  }
  if (Object.keys(result).length !== 3) throw new Error('Нужны три обязательных параметра offline-миграции');
  return {databasePath: result['--database'], backupPath: result['--backup'], offlineConfirmation: result['--offline-confirmation']};
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(migrateArchiveDatabase(argumentsFrom(process.argv.slice(2)))) + '\n'); }
  catch (error) { process.stderr.write(`Миграция архива отменена: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = {migrateArchiveDatabase, argumentsFrom};
