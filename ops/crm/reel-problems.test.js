'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createReelMaterials}=require('./reel-materials');
const actor={userId:7,userName:'SAMPLE редактор',role:'editor'};
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES(1,'alpha','SAMPLE компания',0),(2,'beta','SAMPLE другая',0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,created_at TEXT,updated_at TEXT,title TEXT,description TEXT,company_code TEXT,
      assignee_role TEXT,assignee_name TEXT,status TEXT,source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);`);
  let materials=createReelMaterials(db);
  const reel=materials.create('alpha',{title:'SAMPLE старый ролик',mediaUrl:'https://synapse.synapsebusiness.ru/content/publishing-assets/alpha/'+'a'.repeat(32)+'.mp4'},actor);
  materials=createReelMaterials(db);
  return {db,materials,reel,body:{clientRequestId:'problem-1',text:'Не включается звук',version:1}};
}
test('проблема старого ролика: задача Claude, постоянный номер, без очередей и переписки',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const before=f.materials.get('alpha',f.reel.id),a=f.materials.reportProblem('alpha',f.reel.id,f.body,actor);
  assert.equal(a.duplicate,false);
  const task=f.db.prepare('SELECT * FROM tasks').get();
  assert.equal(task.assignee_name,'Claude');assert.equal(task.title,'Монтаж: проблема — SAMPLE старый ролик');assert.equal(task.company_code,'alpha');
  for(const part of ['Не включается звук','SAMPLE компания','v1','SAMPLE редактор','#content/materials/reel/'+f.reel.id])assert.ok(task.description.includes(part));
  assert.deepEqual(f.materials.reportProblem('alpha',f.reel.id,f.body,actor),{taskId:a.taskId,duplicate:true});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
  const after=f.materials.get('alpha',f.reel.id);assert.equal(after.problemReports[0].taskId,a.taskId);
  for(const field of ['versions','edits','requests','history','log'])assert.deepEqual(after[field],before[field]);
  assert.deepEqual(f.materials.queue('alpha').edits,[]);assert.deepEqual(f.materials.requestQueue('alpha').requests,[]);
});
test('компания, версия, длина, автор ключа и откат при сбое регистрации',t=>{
  const f=fixture();t.after(()=>f.db.close());
  assert.throws(()=>f.materials.reportProblem('beta',f.reel.id,f.body,actor),{status:404});
  for(const body of [{text:''},{text:'x'.repeat(1501)},{version:9},{version:'1'},{authorId:1}])assert.throws(()=>f.materials.reportProblem('alpha',f.reel.id,{...f.body,...body},actor),{status:400});
  f.materials.reportProblem('alpha',f.reel.id,{...f.body,text:'x'.repeat(1500)},actor);
  assert.throws(()=>f.materials.reportProblem('alpha',f.reel.id,f.body,{...actor,userId:8}),{status:409});
  f.db.exec("CREATE TRIGGER fail_problem BEFORE INSERT ON reel_problem_reports BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>f.materials.reportProblem('alpha',f.reel.id,{...f.body,clientRequestId:'second'},actor),/fixture/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
});
