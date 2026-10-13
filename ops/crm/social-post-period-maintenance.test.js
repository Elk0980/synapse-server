'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {maintainPostPeriods}=require('./social-post-period-maintenance');
function fixture(t){
 const prefix='synapse-period-maintenance-',root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
 const dbPath=path.join(root,'source.sqlite');
 const db=new DatabaseSync(dbPath);
 db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE social_posts(id INTEGER PRIMARY KEY,company_code TEXT,platform TEXT,platform_post_id TEXT);
 INSERT INTO social_posts VALUES(1,'maintenance','max','native-fixture');
 CREATE TABLE social_post_metrics(post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,date TEXT NOT NULL,metric TEXT NOT NULL,value REAL,unit TEXT NOT NULL,source_field TEXT NOT NULL DEFAULT '',completeness TEXT NOT NULL DEFAULT 'unknown',provider TEXT NOT NULL,collected_at TEXT NOT NULL,run_id INTEGER,period TEXT NOT NULL DEFAULT 'unknown',PRIMARY KEY(post_id,date,metric,period));
 INSERT INTO social_post_metrics VALUES(1,'2026-10-01','views',2,'views','native','complete','direct','2026-10-13T12:00:00Z',7,'day');
 INSERT INTO social_post_metrics VALUES(1,'2026-10-01','views',40,'views','native','complete','direct','2026-10-13T12:00:00Z',8,'lifetime');`);
 db.close();
 t.after(()=>{
  const absolute=fs.realpathSync(root),parent=fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(absolute),parent);assert.ok(path.basename(absolute).startsWith(prefix));
  assert.equal(fs.lstatSync(root).isSymbolicLink(),false);
  fs.rmSync(root,{recursive:true});
 });
 return {dbPath,backupPath:path.join(root,'before.sqlite'),root};
}
test('чтение схемы не меняет базу; применение требует остановленных writers и новой backup',async t=>{
 const f=fixture(t),before=fs.readFileSync(f.dbPath);
 const inspection=await maintainPostPeriods({dbPath:f.dbPath});
 assert.equal(inspection.before.schema,'period');assert.equal(inspection.before.rows,2);
 assert.deepEqual(fs.readFileSync(f.dbPath),before);
 await assert.rejects(maintainPostPeriods({...f,mode:'rollback'}),{code:'POST_PERIOD_OFFLINE_REQUIRED'});
 fs.writeFileSync(f.backupPath,'keep');
 await assert.rejects(maintainPostPeriods({...f,mode:'rollback',offline:true}),{code:'EEXIST'});
 assert.equal(fs.readFileSync(f.backupPath,'utf8'),'keep');
 assert.deepEqual(fs.readFileSync(f.dbPath),before);
});
test('rollback создаёт проверенную SQLite backup со всеми периодами, upgrade сохраняет mixed неизвестным',async t=>{
 const f=fixture(t);
 const result=await maintainPostPeriods({...f,mode:'rollback',offline:true});
 assert.equal(result.before.rows,2);assert.equal(result.after.schema,'legacy');
 const saved=new DatabaseSync(f.backupPath,{readOnly:true});
 assert.deepEqual(saved.prepare('SELECT period,value FROM social_post_metrics ORDER BY period').all().map(r=>({...r})),[{period:'day',value:2},{period:'lifetime',value:40}]);saved.close();
 const old=new DatabaseSync(f.dbPath);
 assert.equal(old.prepare('SELECT value FROM social_post_metrics').get().value,null);old.close();
 const upgraded=await maintainPostPeriods({...f,backupPath:path.join(f.root,'legacy.sqlite'),mode:'upgrade',offline:true});
 assert.equal(upgraded.after.schema,'period');assert.equal(upgraded.after.rows,2);
});
test('действующий SQLite writer останавливает обслуживание до backup и изменений',async t=>{
 const f=fixture(t),writer=new DatabaseSync(f.dbPath);
 try{
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare('UPDATE social_post_metrics SET value=77 WHERE period=?').run('day');
  await assert.rejects(maintainPostPeriods({...f,mode:'rollback',offline:true}),error=>/busy|locked/i.test(error.message));
  assert.equal(fs.existsSync(f.backupPath),false);
  assert.equal(writer.prepare('SELECT count(*) n FROM social_post_metrics').get().n,2);
 }finally{if(writer.isTransaction)writer.exec('ROLLBACK');writer.close();}
});
