'use strict';
// Только синтетические SQLite-копии. Сеть и рабочий кабинет не используются.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const {createMediaMentor, EMPTY_BRIEF} = require('./media-mentor');
const {createMediaMentorTransfer} = require('./media-mentor-transfer');
const helper = path.join(__dirname, 'media-mentor-legacy-ids.py');
const python = process.platform === 'win32' ? 'python' : 'python3';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-plan-289-'));
  const file = path.join(dir, 'crm-copy.sqlite'), manifestFile = path.join(dir, 'report.json');
  const db = new DatabaseSync(file);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES (1,'taisabai','Test','Asia/Bangkok','[]'),(2,'other','Other','Asia/Bangkok','[]');
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER REFERENCES companies(id));
    INSERT INTO autoposting_posts VALUES(101,1);
    CREATE TABLE reel_materials(id INTEGER PRIMARY KEY,company_id INTEGER REFERENCES companies(id),idea_id TEXT,release_date TEXT);
    INSERT INTO reel_materials VALUES(21,1,NULL,'2026-11-20'),(22,1,NULL,'2026-11-20'),(23,1,NULL,'2026-11-20'),(24,1,NULL,'2026-11-20');`);
  const mentor=createMediaMentor(db);
  createMediaMentorTransfer(db,{mentor,autoposting:{get(){}},information:{get(){}}});
  const dates=['2026-09-24','2026-09-25','2026-09-26','2026-09-27','2026-09-28','2026-10-01','2026-10-07'];
  const days=dates.map((date,i)=>({date,platform:'instagram',format:'post',role:'dialogue',topic:'Пример '+i,script:{text:'Тест'},n:1.25,
    ...(i===1?{ideaId:''}:i===2?{ideaId:null}:{})}));
  const raw=JSON.stringify({days,extra:'Пример «текста»'},null,2)+'\n';
  for(const id of [1,2]) {
    db.prepare('INSERT INTO media_mentor_brief_versions(company_id,revision,brief,created_at) VALUES(?,1,?,?)').run(id,JSON.stringify(EMPTY_BRIEF),'before');
    db.prepare('INSERT INTO media_mentor_briefs VALUES(?,1,?,?)').run(id,JSON.stringify(EMPTY_BRIEF),'before');
    db.prepare('INSERT INTO media_mentor_plan_versions(company_id,revision,brief_revision,plan,created_at) VALUES(?,3,1,?,?)').run(id,raw,'before');
    db.prepare('INSERT INTO media_mentor_plans VALUES(?,3,1,?,?)').run(id,raw,'before');
  }
  db.exec(`INSERT INTO media_mentor_plan_approvals(company_id,plan_revision,brief_revision,decision,decided_at,actor_name) VALUES(1,3,1,'approved','before','Test');
    INSERT INTO media_mentor_plan_feedback(company_id,plan_revision,day_index,message,created_at,actor_name) VALUES(1,3,0,'Тест отзыва','before','Test');
    INSERT INTO media_mentor_plan_transfers(id,company_id,plan_revision,brief_revision,day_count,profile_revision,created_at) VALUES(1,1,3,1,7,1,'before');
    INSERT INTO media_mentor_plan_transfer_items(transfer_id,day_index,plan_date,plan_platform,post_id) VALUES(1,0,'2026-09-24','instagram',101);`);
  const run=(command,extra=[])=>spawnSync(python,['-I',helper,command,'--db',file,...extra],{encoding:'utf8'});
  const report=()=>{const r=run('report');assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const apply=manifest=>{fs.writeFileSync(manifestFile,JSON.stringify(manifest));return run('apply',['--manifest',manifestFile]);};
  const dump=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'"').all().map(row=>({...row}))]));
  return {db,file,mentor,raw,report,apply,dump,run};
}

test('289 report: ровно7 строк, детерминированные ID, ревизия/SHA/связи; файл и все таблицы без изменений',t=>{
  const f=fixture(t),before=fs.readFileSync(f.file),rows=f.dump(),report=f.report();
  assert.equal(report.eligible,true,JSON.stringify(report.blocked));assert.equal(report.rows.length,7);
  assert.deepEqual(report.rows,f.report().rows);assert.equal(new Set(report.rows.map(r=>r.futureId)).size,7);
  assert.equal(report.guard.plan.revision,3);assert.equal(report.planSha256Before,report.planSha256After);
  assert.equal(report.databaseSha256Before,report.databaseSha256After);assert.equal(report.writes,0);
  assert.notEqual(report.projectedPlanSha256,report.planSha256Before);
  assert.deepEqual(report.protectedReels,[21,22,23,24]);
  assert.ok(report.references.some(r=>r.table==='media_mentor_plan_feedback'&&r.candidateIndexes[0]===0));
  assert.ok(report.references.some(r=>r.table==='media_mentor_plan_transfer_items'&&r.candidateIndexes[0]===0));
  assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(f.dump(),rows);
  assert.doesNotMatch(JSON.stringify(report),/Тест отзыва|Пример «текста»|actor_name|sources_url/);
});

test('289 apply НА КОПИИ: только7ID, прочие байты JSON, metadata, история, другаякомпания/ролики/посты сохранены',t=>{
  const f=fixture(t),before=f.dump(),manifest=f.report(),result=f.apply(manifest);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).idsAdded,7);
  const after=f.dump(),raw=after.media_mentor_plans.find(r=>r.company_id===1).plan;
  let expected;
  for(const row of manifest.rows) {
    assert.equal(JSON.parse(raw).days[row.index].ideaId,row.futureId);
  }
  const stripped=JSON.parse(raw);stripped.days.forEach((day,i)=>{if(i===1)day.ideaId='';else if(i===2)day.ideaId=null;else delete day.ideaId;});
  assert.deepEqual(stripped,JSON.parse(f.raw));
  // Удаляем ровно вставленные/заменённые токены и получаем исходные байты JSON.
  expected=raw;
  manifest.rows.forEach((row,i)=>{const token=JSON.stringify(row.futureId);expected=i===1?expected.replace('"ideaId": '+token,'"ideaId": ""'):i===2?expected.replace('"ideaId": '+token,'"ideaId": null'):expected.replace('"ideaId":'+token+',','');});
  assert.equal(expected,f.raw);
  after.media_mentor_plans.find(r=>r.company_id===1).plan=f.raw;
  assert.deepEqual(after,before);
  const once=f.dump();assert.notEqual(f.apply(manifest).status,0);assert.deepEqual(f.dump(),once,'повтор ничего не пишет');
});

test('289 после repair НА КОПИИ штатные archive/restore работают, ревизия/согласования остаются прежними',t=>{
  const f=fixture(t),manifest=f.report();assert.equal(f.apply(manifest).status,0);
  const approval=f.db.prepare('SELECT * FROM media_mentor_plan_approvals').all();
  for(const row of manifest.rows)f.mentor.archiveIdea('taisabai',row.futureId,{reason:'Тест'},{userId:7,userName:'Test'});
  assert.equal(f.mentor.get('taisabai').plan.days.length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_idea_archive').get().n,7);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_idea_archive_events').get().n,7);
  for(const row of manifest.rows)f.mentor.restoreIdea('taisabai',row.futureId,{},{});
  assert.equal(f.mentor.get('taisabai').plan.days.length,7);assert.equal(f.mentor.get('taisabai').plan.revision,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_idea_archive').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_idea_archive_events').get().n,14);
  assert.deepEqual(f.db.prepare('SELECT * FROM media_mentor_plan_approvals').all(),approval);
});

test('289 STOP: изменившийся план/связь или подменённыйmanifest не записываются',t=>{
  for(const kind of ['plan','link','manifest']) {
    const f=fixture(t),manifest=f.report();
    if(kind==='plan')f.db.prepare('UPDATE media_mentor_plans SET updated_at=? WHERE company_id=1').run('later');
    if(kind==='link')f.db.prepare('INSERT INTO media_mentor_idea_links(company_id,idea_id,updated_at) VALUES(1,?,?)').run('other-id','later');
    if(kind==='manifest')manifest.rows[0].futureId='arbitrary-id';
    const before=f.dump();assert.notEqual(f.apply(manifest).status,0);assert.deepEqual(f.dump(),before);
  }
});

test('289 STOP: пустые/неразрешённые связи, другая сетка истории, недостающий день и триггер',t=>{
  for(const kind of ['blank','orphan','reel-date','history','count','trigger']) {
    const f=fixture(t);
    if(kind==='blank')f.db.exec("INSERT INTO media_mentor_idea_links(company_id,idea_id,updated_at) VALUES(1,'','before')");
    if(kind==='orphan')f.db.exec("INSERT INTO media_mentor_idea_links(company_id,idea_id,updated_at) VALUES(1,'undefined','before')");
    if(kind==='reel-date')f.db.exec("UPDATE reel_materials SET release_date='2026-09-24' WHERE id=21");
    if(kind==='history')f.db.exec('DROP TRIGGER media_mentor_plan_versions_immutable_update; UPDATE media_mentor_plan_versions SET plan=\'{"days":[]}\' WHERE company_id=1');
    if(kind==='count') {const p=JSON.parse(f.raw);p.days.pop();f.db.prepare('UPDATE media_mentor_plans SET plan=? WHERE company_id=1').run(JSON.stringify(p));}
    if(kind==='trigger')f.db.exec('CREATE TRIGGER unexpected AFTER UPDATE ON media_mentor_plans BEGIN UPDATE companies SET name=\'wrong\'; END');
    const before=f.dump(),manifest=f.report();assert.equal(manifest.eligible,false);assert.ok(manifest.blocked.length);
    assert.notEqual(f.apply(manifest).status,0);assert.deepEqual(f.dump(),before);
  }
});

test('289 report: другая компания, duplicate JSON keys и live WAL запрещены без записи',t=>{
  const f=fixture(t);assert.notEqual(f.run('report',['--company','other']).status,0);
  f.db.prepare('UPDATE media_mentor_plans SET plan=? WHERE company_id=1').run('{"days":[],"days":[]}');
  const before=fs.readFileSync(f.file);assert.notEqual(f.run('report').status,0);assert.deepEqual(fs.readFileSync(f.file),before);
  fs.writeFileSync(f.file+'-wal','not-a-standalone-backup');assert.notEqual(f.run('report').status,0);
});

test('289 STOP: предложенный ID занят, в истории был ID или отсутствует обязательная таблица',t=>{
  for(const kind of ['collision','historic-id','missing-table']) {
    const f=fixture(t),initial=f.report();
    if(kind==='collision')f.db.prepare('INSERT INTO media_mentor_idea_links(company_id,idea_id,updated_at) VALUES(1,?,?)').run(initial.rows[0].futureId,'before');
    if(kind==='historic-id') {
      const history=JSON.parse(f.raw);history.days[0].ideaId='previous-stable-id';
      f.db.exec('DROP TRIGGER media_mentor_plan_versions_immutable_update');
      f.db.prepare('UPDATE media_mentor_plan_versions SET plan=? WHERE company_id=1').run(JSON.stringify(history));
    }
    if(kind==='missing-table')f.db.exec('DROP TABLE media_mentor_idea_links');
    const before=f.dump(),manifest=f.report();assert.equal(manifest.eligible,false);
    assert.notEqual(f.apply(manifest).status,0);assert.deepEqual(f.dump(),before);
  }
});
