'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {installArchiveSchema} = require('../crm/module-archive-schema');

test('Python SQLite opens the migrated archive, backs it up and enforces immutable history', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-archive-portable-'));
  const file = path.join(directory, 'archive.sqlite');
  t.after(() => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw Error('Неверный путь тестового каталога');
    fs.rmSync(directory, {recursive:true, force:true});
  });
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE tasks(id INTEGER PRIMARY KEY); INSERT INTO tasks VALUES(7);
      CREATE TABLE agents(id INTEGER PRIMARY KEY); INSERT INTO agents VALUES(1);
      CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,agent_id INTEGER REFERENCES agents(id),owner_id INTEGER);
      INSERT INTO agent_sessions VALUES('SAMPLE-session',1,1);`);
    installArchiveSchema(db);
    db.prepare(`INSERT INTO module_archive_entries(module_code,project_code,entry_type,text,links_json,
      task_id,session_id,agent_id,owner_id,client_ref,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('sites','synapse-business','report','SAMPLE старый отчёт','[]',7,'SAMPLE-session',1,1,'SAMPLE-portable','a'.repeat(64),'2026-11-03T00:00:00.000Z');
    db.prepare('VACUUM INTO ?').run(file);
  } finally {db.close();}
  const script = `import sqlite3,sys,json
db=sqlite3.connect(sys.argv[1]); db.execute('PRAGMA foreign_keys=ON')
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert not db.execute('PRAGMA foreign_key_check').fetchall()
assert db.execute('SELECT text FROM module_archive_entries').fetchone()[0]=='SAMPLE старый отчёт'
for sql in ['UPDATE module_archive_entries SET text=text','DELETE FROM module_archive_entries',
            'INSERT OR REPLACE INTO module_archive_entries SELECT * FROM module_archive_entries']:
    try:
        db.execute(sql)
        raise AssertionError('immutable guard did not reject write')
    except sqlite3.IntegrityError:
        db.rollback()
copy=sqlite3.connect(':memory:'); db.backup(copy)
assert copy.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert copy.execute('SELECT count(*) FROM module_archive_entries').fetchone()[0]==1
copy.close();db.close();print(json.dumps({'sqlite':sqlite3.sqlite_version,'status':'PASS'}))
`;
  const result = spawnSync('python', ['-c',script,file], {encoding:'utf8', windowsHide:true, timeout:15000});
  if (result.error?.code === 'ENOENT') return t.skip('Python отсутствует в окружении');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.status, 'PASS');
  t.diagnostic('Проверен Python SQLite ' + proof.sqlite);
});
