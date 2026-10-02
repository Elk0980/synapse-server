'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createReviewTasks}=require('./autoposting-review-tasks'),{createContentFactoryReviewDelays}=require('./content-factory-review-delays');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES(1,'palitra-love','Europe/Moscow',0),(2,'alvi','America/Los_Angeles',0),(3,'utc','',0);
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER DEFAULT 1,content_revision INTEGER DEFAULT 1,status TEXT DEFAULT 'draft',archived_at TEXT,title TEXT,text TEXT,review_state TEXT DEFAULT 'rejected',approved_revision INTEGER,platform_ids TEXT DEFAULT '[]');
    CREATE TABLE autoposting_platform_reviews(post_id INTEGER,platform_id TEXT,state TEXT,content_revision INTEGER,PRIMARY KEY(post_id,platform_id));
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,is_deleted INTEGER DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT DEFAULT '',company_code TEXT DEFAULT '',
      assignee_role TEXT DEFAULT 'synapse' CHECK(assignee_role IN ('owner','admin','marketer','synapse')),assignee_name TEXT DEFAULT '',status TEXT DEFAULT 'inbox' CHECK(status IN ('inbox','planned','in_progress','done','cancelled')),
      due_date TEXT DEFAULT '',source TEXT DEFAULT 'manual',source_ref TEXT DEFAULT '',source_author TEXT DEFAULT '',created_by TEXT DEFAULT '');`);
  const reviews=createReviewTasks(db);let clock=Date.parse('2026-10-01T21:05:00.000Z'),nextPost=0;
  const api=createContentFactoryReviewDelays({db:{prepare:sql=>{assert.match(sql,/^SELECT/);return db.prepare(sql);}},now:()=>clock});
  function post(companyId=1){const id=++nextPost;db.prepare("INSERT INTO autoposting_posts(id,company_id,title,text) VALUES(?,?,?,?)").run(id,companyId,'Не раскрывать title','Не раскрывать текст');return db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(id);}
  function review(row,options={}){
    const owner=db.prepare('SELECT code FROM companies WHERE id=?').get(row.company_id);reviews.save(row,owner,'Частная инструкция',[],{userId:7,userName:'Автор'},'2026-10-01T00:00:00.000Z');
    const taskId=db.prepare('SELECT task_id FROM autoposting_review_tasks WHERE post_id=? AND post_revision=?').get(row.id,row.revision).task_id;
    const fields={due_date:'2026-10-01',assignee_name:'Назначенный редактор',assignee_role:'marketer',...options};
    for(const [key,value]of Object.entries(fields))db.prepare(`UPDATE tasks SET ${key}=? WHERE id=?`).run(value,taskId);return taskId;
  }
  return {db,api,post,review,set clock(value){clock=Date.parse(value);},changes:()=>db.prepare('SELECT total_changes() n').get().n};
}
test('назначенные реальные задачи: DTO без частного содержимого и строго read-only',t=>{
  const f=fixture(t),post=f.post(),taskId=f.review(post),before=f.changes(),result=f.api.pending();assert.equal(f.changes(),before);assert.equal(result.items.length,1);assert.equal(result.hasMore,false);
  assert.deepEqual(result.items[0],{companyCode:'palitra-love',timezone:'Europe/Moscow',timezoneSource:'company',postId:post.id,contentRevision:1,taskId,taskStatus:'inbox',assigneeRole:'marketer',assigneeName:'Назначенный редактор',dueDate:'2026-10-01',
    asOfDate:'2026-10-02',detectedAt:'2026-10-01T21:05:00.000Z',eventKey:`content-review-delay:palitra-love:${post.id}:${taskId}:2026-10-01:1`});
  const json=JSON.stringify(result);for(const secret of ['Не раскрывать','Частная инструкция','description','annotations','title'])assert.ok(!json.includes(secret));
});
test('нет дедлайна, due today, impossible/date-time и завершённые/удалённые задачи исключаются; нет имени — честный пустой assignee',t=>{
  const f=fixture(t);for(const options of [{due_date:''},{due_date:'2026-10-02'},{due_date:'2026-02-30'},
    {due_date:'2026-10-01T09:00:00Z'},{status:'done'},{status:'cancelled'},{is_deleted:1},{assignee_name:'Редактор\nинструкция'}])f.review(f.post(),options);
  assert.deepEqual(f.api.pending().items,[]);f.review(f.post(),{assignee_name:''});assert.equal(f.api.pending().items[0].assigneeName,'');
});
test('самая свежая связь suppresses прежнюю даже если новая завершена; stale contentRevision не уведомляется',t=>{
  const f=fixture(t),post=f.post();f.review(post);
  f.review({...post,revision:2},{status:'done'});assert.deepEqual(f.api.pending().items,[]);
  const other=f.post();f.review(other);f.db.prepare('UPDATE autoposting_posts SET content_revision=2,revision=2 WHERE id=?').run(other.id);assert.deepEqual(f.api.pending().items,[]);
  f.review({...other,revision:3,content_revision:2});const current=f.api.pending().items;assert.equal(current.length,1);assert.equal(current[0].contentRevision,2);
});
test('company scope, reassigned company, archived/deleted/published/publishing/cancelled исключаются',t=>{
  const f=fixture(t),a=f.post(),ta=f.review(a),b=f.post(2);f.review(b,{due_date:'2026-09-30'});assert.equal(f.api.pending({companyCode:'PALITRA-LOVE'}).items.length,1);assert.equal(f.api.pending({companyCode:'alvi'}).items[0].postId,b.id);
  f.db.prepare("UPDATE tasks SET company_code='alvi' WHERE id=?").run(ta);assert.deepEqual(f.api.pending({companyCode:'palitra-love'}).items,[]);f.db.prepare("UPDATE tasks SET company_code='palitra-love' WHERE id=?").run(ta);
  for(const status of ['published','publishing','cancelled']){f.db.prepare('UPDATE autoposting_posts SET status=? WHERE id=?').run(status,a.id);assert.deepEqual(f.api.pending({companyCode:'palitra-love'}).items,[]);}
  f.db.prepare("UPDATE autoposting_posts SET status='draft',archived_at='2026-10-01' WHERE id=?").run(a.id);assert.deepEqual(f.api.pending({companyCode:'palitra-love'}).items,[]);
  f.db.prepare('UPDATE autoposting_posts SET archived_at=NULL WHERE id=?').run(a.id);f.db.prepare('UPDATE companies SET is_deleted=1 WHERE id=1').run();assert.deepEqual(f.api.pending({companyCode:'palitra-love'}).items,[]);
});
test('due_date — дата компании, без выдуманного времени: midnight, DST, пустой/неверный timezone',t=>{
  const f=fixture(t),moscow=f.post(),la=f.post(2),utc=f.post(3);f.review(moscow);f.review(la);f.review(utc);
  f.clock='2026-10-01T20:59:59.999Z';assert.deepEqual(f.api.pending().items,[]);f.clock='2026-10-01T21:00:00.000Z';assert.deepEqual(f.api.pending().items.map(item=>item.postId),[moscow.id]);
  f.clock='2026-10-02T00:00:00.000Z';assert.equal(f.api.pending({companyCode:'utc'}).items[0].timezone,'UTC');assert.equal(f.api.pending({companyCode:'utc'}).items[0].timezoneSource,'utc_fallback');assert.deepEqual(f.api.pending({companyCode:'alvi'}).items,[]);
  f.clock='2026-10-02T07:00:00.000Z';assert.equal(f.api.pending({companyCode:'alvi'}).items[0].asOfDate,'2026-10-02');
  f.db.prepare("UPDATE tasks SET due_date='2026-11-01' WHERE company_code='alvi'").run();f.clock='2026-11-02T07:59:59.999Z';assert.deepEqual(f.api.pending({companyCode:'alvi'}).items,[]);
  f.clock='2026-11-02T08:00:00.000Z';assert.equal(f.api.pending({companyCode:'alvi'}).items.length,1);
  f.db.prepare("UPDATE companies SET timezone='Unknown/Zone' WHERE id=1").run();assert.deepEqual(f.api.pending({companyCode:'palitra-love'}).items,[]);
});
test('новый срок/версия дают новый key; reassign сохраняет key и фактическое имя; cap <=100',t=>{
  const f=fixture(t),post=f.post(),taskId=f.review(post),first=f.api.pending().items[0];f.db.prepare("UPDATE tasks SET assignee_name='Другой редактор',due_date='2026-09-30' WHERE id=?").run(taskId);
  const changed=f.api.pending().items[0];assert.notEqual(changed.eventKey,first.eventKey);assert.equal(changed.assigneeName,'Другой редактор');
  f.db.prepare("UPDATE tasks SET assignee_name='Третий редактор' WHERE id=?").run(taskId);assert.equal(f.api.pending().items[0].eventKey,changed.eventKey);
  f.db.prepare("UPDATE tasks SET due_date='2026-10-05' WHERE id=?").run(taskId);assert.deepEqual(f.api.pending().items,[]);
  for(let i=0;i<105;i++)f.review(f.post());const summary=f.api.pending();assert.equal(summary.items.length,100);assert.equal(summary.hasMore,true);assert.equal(f.api.pending({limit:1}).items.length,1);
  const tail=f.api.pending({afterTaskId:summary.nextAfterTaskId});assert.equal(tail.items.length,5);assert.equal(tail.hasMore,false);assert.equal(tail.nextAfterTaskId,0);assert.ok(tail.items.every(item=>item.taskId>summary.nextAfterTaskId));
  for(const options of [{limit:101},{limit:0},{limit:'1'},{companyCode:'bad/code'},{afterTaskId:-1},{afterTaskId:'1'}])assert.throws(()=>f.api.pending(options),{status:400});
});
test('разрешённое согласование исключается без изменения contentRevision; partial/stale — не полное одобрение',t=>{
  const f=fixture(t),post=f.post();f.review(post);f.db.prepare("UPDATE autoposting_posts SET review_state='approved' WHERE id=?").run(post.id);assert.deepEqual(f.api.pending().items,[]);
  f.db.prepare("UPDATE autoposting_posts SET review_state='pending',approved_revision=1 WHERE id=?").run(post.id);assert.deepEqual(f.api.pending().items,[],'legacy content approval');
  f.db.prepare("UPDATE autoposting_posts SET platform_ids='[\"telegram\",\"vk\"]' WHERE id=?").run(post.id);
  f.db.prepare("INSERT INTO autoposting_platform_reviews VALUES(?,'telegram','approved',1),(?,'vk','pending',1)").run(post.id,post.id);assert.equal(f.api.pending().items.length,1);
  f.db.prepare("UPDATE autoposting_platform_reviews SET state='approved' WHERE platform_id='vk'").run();assert.deepEqual(f.api.pending().items,[]);
  f.db.prepare("UPDATE autoposting_posts SET approved_revision=0,review_state='rejected' WHERE id=?").run(post.id);assert.equal(f.api.pending().items.length,1,'stale approval не согласует текущую версию');
});
