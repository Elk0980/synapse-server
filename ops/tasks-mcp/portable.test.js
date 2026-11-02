'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const {createTaskCoordination,migrateTasksMcp,migrateTasksMcpPortable} = require('../crm/task-coordination');

const owner = {role:'owner',userId:7,companyCodes:new Set(['alpha'])};
const now = () => Date.parse('2026-11-03T00:00:00Z');
const whitespace = [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,
  8232,8233,8239,8287,12288,65279];
const upperRu = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
const portableObjects = ['agents_name_key_uidx','agents_name_key_insert','agents_name_key_update',
  'tasks_reviewer_insert','tasks_reviewer_update'];

function oldDeepKey(expression) {
  let result = `lower(trim(${expression},char(${whitespace.join(',')})))`;
  for (const letter of upperRu) result = `replace(${result},'${letter}','${letter.toLowerCase()}')`;
  return result;
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try { callback(); db.exec('COMMIT'); }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

function fixture(t, filename=':memory:') {
  const db = new DatabaseSync(filename);
  t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old'),(4,'old'),(5,'old'),(6,'old'),(7,'old');
    CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES('alpha',0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT DEFAULT '',
      company_code TEXT NOT NULL DEFAULT 'alpha',assignee_name TEXT NOT NULL DEFAULT '',
      status TEXT DEFAULT 'inbox',priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',
      source TEXT DEFAULT 'manual' CHECK(source IN('manual','chat','telegram','pipeline')),
      extra_runtime_column TEXT DEFAULT 'untouched');
    INSERT INTO tasks(id,created_at,updated_at,title,assignee_name) VALUES(21,'old','old','SAMPLE задача','Codex');
    CREATE INDEX old_task_title_idx ON tasks(title);
    CREATE TABLE old_audit(task_id INTEGER REFERENCES tasks(id),note TEXT);
    CREATE TRIGGER old_task_audit AFTER UPDATE OF title ON tasks
      BEGIN INSERT INTO old_audit VALUES(NEW.id,'old trigger'); END;
    CREATE TABLE old_blob(id INTEGER PRIMARY KEY,data BLOB);
    INSERT INTO old_blob VALUES(1,x'0001ff');`);
  createTaskCoordination(db,{now}).save(21,{revision:0,data:{executorName:'Claude',result:'SAMPLE результат',
    milestones:{code:{state:'confirmed',evidence:'SAMPLE проверка',checkedAt:'2026-11-02T23:00:00Z'}}}},owner);
  db.exec('PRAGMA foreign_keys=OFF');
  try { transaction(db,()=>migrateTasksMcp(db)); }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
  db.prepare('INSERT INTO schema_migrations VALUES(8,?)').run(new Date(now()).toISOString());
  const api = createTaskCoordination(db,{now});
  api.tool('task_comment',{task_id:21,author:'Codex',text:'SAMPLE история'},owner);
  api.tool('agent_report',{agent:'Клод',kind:'claude',state:'work',last_event:'SAMPLE'},owner);
  return {db,api};
}

function installPreviousV8Schema(db) {
  db.exec(`DROP INDEX agents_name_key_uidx;
    DROP TRIGGER agents_name_key_insert; DROP TRIGGER agents_name_key_update;
    DROP TRIGGER tasks_reviewer_insert; DROP TRIGGER tasks_reviewer_update;
    CREATE UNIQUE INDEX agents_name_key_uidx ON agents(${oldDeepKey('name')});
    CREATE TRIGGER tasks_reviewer_insert BEFORE INSERT ON tasks
      WHEN ${oldDeepKey('NEW.reviewer_name')}<>'' AND ${oldDeepKey('NEW.reviewer_name')}=${oldDeepKey('NEW.assignee_name')}
      BEGIN SELECT RAISE(ABORT,'TASK_REVIEWER_EQUALS_EXECUTOR'); END;
    CREATE TRIGGER tasks_reviewer_update BEFORE UPDATE OF reviewer_name,assignee_name ON tasks
      WHEN ${oldDeepKey('NEW.reviewer_name')}<>'' AND ${oldDeepKey('NEW.reviewer_name')}=${oldDeepKey('NEW.assignee_name')}
      BEGIN SELECT RAISE(ABORT,'TASK_REVIEWER_EQUALS_EXECUTOR'); END;`);
}

function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return tables.map(({name})=>{
    const quoted = '"'+name.replace(/"/g,'""')+'"';
    const cols = db.prepare(`PRAGMA table_xinfo(${quoted})`).all().map(row=>'"'+row.name.replace(/"/g,'""')+'"');
    return {name,columns:db.prepare(`PRAGMA table_xinfo(${quoted})`).all(),
      rows:db.prepare(`SELECT * FROM ${quoted} ORDER BY ${cols.join(',')}`).all(),
      foreignKeys:db.prepare(`PRAGMA foreign_key_list(${quoted})`).all()};
  });
}

function maxParentheses(sql) {
  let current=0,maximum=0,quoted=false;
  for(let index=0;index<sql.length;index++) {
    const char=sql[index];
    if(char==="'") {
      if(quoted&&sql[index+1]==="'") { index++; continue; }
      quoted=!quoted;
    }
    if(quoted) continue;
    if(char==='(') maximum=Math.max(maximum,++current);
    if(char===')') current--;
  }
  return maximum;
}

const insertAgent = (db,name) => db.prepare(`INSERT INTO agents(name,kind,state,last_event_at)
  VALUES(?,'codex','idle','2026-11-03T00:00:00Z')`).run(name);
const insertTask = (db,executor,reviewer) => db.prepare(`INSERT INTO tasks
  (created_at,updated_at,title,assignee_name,reviewer_name) VALUES('old','old','SAMPLE',?,?)`).run(executor,reviewer);

test('migration 9 replaces only task MCP schema objects and preserves every row, column, FK and sequence',t=>{
  const {db}=fixture(t);
  installPreviousV8Schema(db);
  const before = snapshot(db);
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  transaction(db,()=>migrateTasksMcpPortable(db));
  assert.deepEqual(snapshot(db),before);
  const after = new Map(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all().map(row=>[row.name,row]));
  for(const row of schema) if(!portableObjects.includes(row.name)) assert.deepEqual(after.get(row.name),row);
  for(const name of portableObjects) {
    assert.ok(after.has(name));
    assert.ok(maxParentheses(after.get(name).sql)<12,`persisted parser depth: ${name}`);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  transaction(db,()=>migrateTasksMcpPortable(db));
  assert.deepEqual(snapshot(db),before,'repeated schema helper cannot rewrite data');
});

test('fresh migration 8 installs shallow persistent SQL and keeps reviewer and all 33 Cyrillic canonical pairs',t=>{
  const {db}=fixture(t);
  for(const name of portableObjects) {
    const sql=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql;
    assert.ok(maxParentheses(sql)<12);
  }
  for(const letter of upperRu) {
    const upper=`SAMPLE ${letter}`, lower=`sample ${letter.toLowerCase()}`;
    insertAgent(db,upper);
    assert.throws(()=>insertAgent(db,lower),/UNIQUE constraint failed/);
    assert.throws(()=>insertTask(db,upper,lower),/TASK_REVIEWER_EQUALS_EXECUTOR/);
  }
  assert.throws(()=>insertTask(db,' ЁЖИКA ','\u00a0ёжикa\ufeff'),/TASK_REVIEWER_EQUALS_EXECUTOR/);
  const row=insertTask(db,'ЁЖИКA','Проверяющий');
  assert.throws(()=>db.prepare('UPDATE tasks SET reviewer_name=? WHERE id=?').run('\u3000ёжикa\t',row.lastInsertRowid),/TASK_REVIEWER_EQUALS_EXECUTOR/);
  db.prepare('UPDATE tasks SET reviewer_name=? WHERE id=?').run('Другой',row.lastInsertRowid);
  assert.throws(()=>db.prepare('UPDATE tasks SET assignee_name=? WHERE id=?').run(' ДРУГОЙ ',row.lastInsertRowid),/TASK_REVIEWER_EQUALS_EXECUTOR/);
  assert.doesNotThrow(()=>insertTask(db,'','\t\u00a0\ufeff'));
});

test('Unicode edge whitespace normalization, agent rename and exact-name upsert retain canonical uniqueness',t=>{
  const {db,api}=fixture(t);
  for(const [index,point] of whitespace.entries()) {
    const char=String.fromCodePoint(point), base=`SAMPLE Ёжик${index}`;
    insertAgent(db,base);
    assert.throws(()=>insertAgent(db,`${char}sample ёжик${index}${char}`),/UNIQUE constraint failed/);
    assert.throws(()=>insertTask(db,base,`${char}sample ёжик${index}${char}`),/TASK_REVIEWER_EQUALS_EXECUTOR/);
  }
  const first=insertAgent(db,'\u00a0 ЁЖИКA\ufeff'), second=insertAgent(db,'Другое имя');
  assert.throws(()=>db.prepare('UPDATE agents SET name=? WHERE id=?').run('\tёжикa\u3000',second.lastInsertRowid),/UNIQUE constraint failed/);
  db.prepare('UPDATE agents SET name=? WHERE id=?').run('ёжикa',first.lastInsertRowid);
  db.prepare(`INSERT INTO agents(name,kind,state,last_event_at) VALUES('ёжикa','codex','wait','old')
    ON CONFLICT(name) DO UPDATE SET state=excluded.state`).run();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id=?').get(first.lastInsertRowid).state,'wait');
  const report=api.tool('agent_report',{agent:'ЁЖИКA',state:'work',last_event:'SAMPLE повтор'},owner).agent;
  assert.equal(report.id,Number(first.lastInsertRowid));assert.equal(report.state,'work');
  assert.doesNotThrow(()=>insertAgent(db,'Ё ЖИКA'),'internal spaces remain meaningful');
  assert.throws(()=>insertAgent(db,'ёжикa'),/UNIQUE constraint failed/);
});

test('portable migration keeps legacy revision/history guards and immutable records',t=>{
  const {db,api}=fixture(t);
  installPreviousV8Schema(db);
  transaction(db,()=>migrateTasksMcpPortable(db));
  const before=api.get(21,owner);
  db.prepare('UPDATE tasks SET assignee_name=?,updated_at=? WHERE id=21').run('Gemini','2026-11-03T00:01:00Z');
  const after=api.get(21,owner);
  assert.equal(after.revision,before.revision+1);assert.equal(after.updatedBy,0);
  assert.deepEqual(after.milestones,before.milestones);assert.equal(after.result,before.result);
  assert.throws(()=>api.save(21,{revision:before.revision,data:{executorName:'Claude'}},owner),error=>error.status===409);
  assert.equal(api.get(21,owner).executorName,'Gemini');
  assert.throws(()=>db.exec("UPDATE task_coordination_history SET data='{}'"),/Immutable/);
  assert.throws(()=>db.exec('DELETE FROM task_assignment_migration'),/Immutable/);
  assert.equal(db.prepare('SELECT count(*) n FROM task_coordination_write_context').get().n,0);
});

test('migration refuses unexpected canonical duplicates before changing any schema or rows',t=>{
  const {db}=fixture(t);
  db.exec('DROP INDEX agents_name_key_uidx; DROP TRIGGER agents_name_key_insert; DROP TRIGGER agents_name_key_update');
  insertAgent(db,'\u00a0клОД\ufeff');
  const before=snapshot(db), beforeSchema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  assert.throws(()=>transaction(db,()=>migrateTasksMcpPortable(db)),/совпадающие канонические имена/);
  assert.deepEqual(snapshot(db),before);
  assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),beforeSchema);
});

test('Python sqlite interoperability: schema/backup/read and raw name/reviewer constraints',t=>{
  const available=spawnSync('python',['-c','import sqlite3; print(sqlite3.sqlite_version)'],{encoding:'utf8',windowsHide:true});
  if(available.error||available.status!==0) { t.skip('Python sqlite3 недоступен; старый SQLite проверяется отдельно');return; }
  t.diagnostic(`Node SQLite ${process.versions.sqlite}; Python SQLite ${available.stdout.trim()}; это фактические локальные версии`);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'task-mcp-portable-'));
  const filename=path.join(directory,'crm.sqlite');
  const {db}=fixture(t,filename);
  installPreviousV8Schema(db);
  transaction(db,()=>migrateTasksMcpPortable(db));
  t.after(()=>{
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    fs.rmSync(directory,{recursive:true,force:true});
  });
  const python=String.raw`
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA foreign_keys=ON')
assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert c.execute('PRAGMA foreign_key_check').fetchall()==[]
assert c.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]>0
backup=sqlite3.connect(':memory:'); c.backup(backup)
assert backup.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
checks=0
def agent(name):
 return c.execute("INSERT INTO agents(name,kind,state,last_event_at) VALUES(?,'codex','idle','old')",(name,)).lastrowid
def rejected(sql,params,marker):
 global checks
 try: c.execute(sql,params)
 except sqlite3.IntegrityError as error:
  assert marker in str(error); checks+=1
 else: raise AssertionError('constraint did not reject')
c.execute('BEGIN')
first=agent(chr(160)+' ЁЖИКA'+chr(65279))
rejected("INSERT INTO agents(name,kind,state,last_event_at) VALUES(?,'codex','idle','old')",('\tёжикa\u3000',),'UNIQUE constraint failed')
second=agent('Другое')
rejected('UPDATE agents SET name=? WHERE id=?',('ёжикa',second),'UNIQUE constraint failed')
c.execute('UPDATE agents SET name=? WHERE id=?',('ёжикa',first))
c.execute("INSERT INTO agents(name,kind,state,last_event_at) VALUES('ёжикa','codex','wait','old') ON CONFLICT(name) DO UPDATE SET state=excluded.state")
rejected("INSERT INTO tasks(created_at,updated_at,title,assignee_name,reviewer_name) VALUES('old','old','SAMPLE',?,?)",('ЁЖИКA','\u00a0ёжикa\ufeff'),'TASK_REVIEWER_EQUALS_EXECUTOR')
revision=c.execute('SELECT revision FROM task_coordination WHERE task_id=21').fetchone()[0]
c.execute("UPDATE tasks SET status='planned',updated_at='new' WHERE id=21")
assert c.execute('SELECT revision FROM task_coordination WHERE task_id=21').fetchone()[0]==revision+1
c.rollback(); backup.close(); c.close()
print(json.dumps({'sqlite':sqlite3.sqlite_version,'checks':checks}))
`;
  const result=spawnSync('python',['-c',python,filename],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.checks,3);assert.equal(report.sqlite,available.stdout.trim());
});
