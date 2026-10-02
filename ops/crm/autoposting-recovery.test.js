'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertRecoverableDraft}=require('./autoposting-recovery');
const blocked=(row,deliveries=[],receipts=[],code='ARCHIVE_UNSAFE')=>assert.throws(()=>assertRecoverableDraft(row,deliveries,receipts),e=>e.status===409&&e.details.code===code);
test('CF5: отмена карточки не разрешает скрыть начавшуюся или неопределённую доставку',()=>{
  for(const status of ['publishing','needs_review','published','pending'])blocked({status:'cancelled'},[{status}]);
  for(const proof of [{provider_post_id:'remote-1'},{external_id:'receipt-1'},{url:'https://example.test/post/1'},{provider_status:'scheduled'}])
    blocked({status:'cancelled'},[{status:'cancelled',...proof}]);
});
test('CF5: подтверждение внешней публикации защищает даже отредактированный черновик',()=>{
  blocked({status:'draft'},[],[{content_revision:1}],'ARCHIVE_PUBLISHED');
});
test('CF5: расписание требует отдельного снятия; неизвестный статус закрыт по умолчанию',()=>{
  blocked({status:'scheduled'},[],[],'ARCHIVE_SCHEDULED');
  for(const status of ['publishing','needs_review','published','future-state',undefined])blocked({status});
  blocked({status:'draft',archived_at:'2026-10-01T00:00:00Z'},[],[],'POST_ARCHIVED');
});
test('CF5: чистый черновик и однозначно неотправленные доставки допускают последующую архивацию',()=>{
  assert.doesNotThrow(()=>assertRecoverableDraft({status:'draft'},[],[]));
  assert.doesNotThrow(()=>assertRecoverableDraft({status:'cancelled'},[{status:'cancelled'},{status:'failed'}],[]));
});

const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createRecovery}=require('./autoposting-recovery');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
 INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'qa','QA','UTC','[]'),(2,'other','Other','UTC','[]');`);
 const transport={getSettings:()=>({channels:[]}),publish:()=>{throw Error('Недопустимый внешний вызов')}};
 const information=createCompanyInformation(db),api=createAutoposting(db,{information,transport});
 const post=api.create('qa',{title:'Черновик',text:'Текст',mediaUrls:[],platformIds:['telegram'],scheduledAt:null},1);
 return {db,api,transport,post,recovery:createRecovery(db)};
}
test('CF5: транзакционный цикл сохраняет текст/историю, отзывает согласования и защищает revision/company',t=>{
 const {db,post:p,recovery:r}=fixture(t);
 db.prepare("UPDATE autoposting_posts SET approved_revision=content_revision,approved_by=1,approved_at='2026-10-01',scheduled_at='2026-11-01T00:00:00Z' WHERE id=?").run(p.id);
 db.prepare("INSERT INTO autoposting_platform_reviews(post_id,platform_id,state,content_revision,created_at) VALUES(?,'telegram','approved',1,'2026-10-01')").run(p.id);
 assert.throws(()=>r.archive(p.id,'other',{revision:p.revision}),e=>e.status===404);
 const a=r.archive(p.id,'qa',{revision:p.revision},{userId:1});
 assert.ok(a.archived_at);assert.equal(a.scheduled_at,null);assert.equal(a.approved_revision,null);
 assert.throws(()=>r.restore(p.id,'qa',{revision:p.revision}),e=>e.details.code==='REVISION_CONFLICT');
 const restored=r.restore(p.id,'qa',{revision:a.revision});
 assert.equal(restored.archived_at,null);assert.equal(restored.status,'draft');assert.equal(restored.text,p.text);assert.equal(restored.approved_revision,null);
 assert.equal(db.prepare('SELECT state FROM autoposting_platform_reviews WHERE post_id=?').get(p.id).state,'pending');
 assert.deepEqual(db.prepare('SELECT action FROM autoposting_recovery_events ORDER BY id').all().map(x=>x.action),['archived','restored']);
});
test('CF5: ошибка записи истории откатывает архив и снятие согласования',t=>{
 const {db,post:p,recovery:r}=fixture(t);
 db.prepare('UPDATE autoposting_posts SET approved_revision=content_revision WHERE id=?').run(p.id);
 db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON autoposting_recovery_events BEGIN SELECT RAISE(ABORT,'QA failure'); END;");
 assert.throws(()=>r.archive(p.id,'qa',{revision:p.revision}));
 const row=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(p.id);
 assert.equal(row.revision,p.revision);assert.equal(row.archived_at,null);assert.equal(row.approved_revision,row.content_revision);
});

test('CF5-R: повторный импорт показывает удалённый дубль и ничего не восстанавливает',t=>{
 const {api}=fixture(t),body={items:[{id:'recover-import',day:1,title:'Импорт для восстановления',text:'Проверка'}]};
 const imported=api.importPackage('qa',body).created[0];
 const archived=api.archive(imported.id,'qa',{revision:imported.revision});
 const again=api.importPackage('qa',body);
 assert.equal(again.created.length,0);assert.equal(again.skipped.length,1);
 assert.equal(again.skipped[0].id,imported.id);assert.equal(again.skipped[0].archivedAt,archived.archive.archivedAt);
 assert.match(again.skipped[0].note,/удалена.*восстановить/);
 assert.equal(api.get(imported.id,'qa').archive.archivedAt,archived.archive.archivedAt);
});
function linkedTasks(db,id){
 db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,company_code TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT,status TEXT);
 CREATE TABLE autoposting_review_tasks(post_id INTEGER,company_id INTEGER,task_id INTEGER REFERENCES tasks(id));
 INSERT INTO tasks VALUES(1,'Доработать материал','qa',0,'before','inbox'),(2,'Ручная правка','qa',0,'before','in_progress'),
 (3,'Чужая задача','other',0,'before','inbox'),(4,'Удалённая задача','qa',1,'before','inbox'),(5,'Переносимая задача','qa',0,'before','in_progress');`);
 db.exec("ALTER TABLE tasks ADD COLUMN assignee_name TEXT DEFAULT 'QA исполнитель';ALTER TABLE tasks ADD COLUMN due_date TEXT DEFAULT '2026-10-02';");
 for(let task=1;task<=5;task++)db.prepare('INSERT INTO autoposting_review_tasks VALUES(?,1,?)').run(id,task);
}
test('CF5-R: задача удалённого материала помечается атомарно; восстановление сохраняет ручные правки и чужую область',t=>{
 const {db,api,post:p}=fixture(t);linkedTasks(db,p.id);
 const archived=api.archive(p.id,'qa',{revision:p.revision});
 const read=id=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
 assert.equal(read(1).title,'[Материал удалён] Доработать материал');assert.equal(read(1).status,'inbox');
 assert.equal(read(2).status,'in_progress');assert.equal(read(3).title,'Чужая задача');assert.equal(read(4).title,'Удалённая задача');
 db.prepare("UPDATE tasks SET title='Отредактировано вручную' WHERE id=2").run();
 db.prepare("UPDATE tasks SET company_code='other',title='Теперь другая компания' WHERE id=5").run();
 const restored=api.restore(p.id,'qa',{revision:archived.revision});
 assert.equal(read(1).title,'Доработать материал');assert.equal(read(2).title,'Отредактировано вручную');
 assert.equal(read(5).title,'Теперь другая компания');assert.equal(read(5).company_code,'other');
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_recovery_task_marks').get().n,0);
 assert.deepEqual([read(1).assignee_name,read(1).due_date],['QA исполнитель','2026-10-02']);
 const twice=api.archive(p.id,'qa',{revision:restored.revision});
 db.prepare('UPDATE tasks SET is_deleted=1 WHERE id=1').run();
 api.restore(p.id,'qa',{revision:twice.revision});
 assert.equal(read(1).is_deleted,1);assert.equal(read(1).title,'[Материал удалён] Доработать материал');
 assert.equal(read(2).title,'Отредактировано вручную');assert.equal(read(5).title,'Теперь другая компания');
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_recovery_task_marks').get().n,0);
});
test('CF5-R: отказ восстановления задачи сохраняет весь архив и его пометки',t=>{
 const {db,api,post:p}=fixture(t);linkedTasks(db,p.id);
 const archived=api.archive(p.id,'qa',{revision:p.revision});
 db.exec("CREATE TRIGGER fail_task_restore BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'restore task refused'); END;");
 assert.throws(()=>api.restore(p.id,'qa',{revision:archived.revision}),/restore task refused/);
 assert.equal(api.get(p.id,'qa').archive.archivedAt,archived.archive.archivedAt);assert.equal(api.get(p.id,'qa').revision,archived.revision);
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_recovery_task_marks').get().n,3);
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_recovery_events').get().n,1);
 assert.equal(db.prepare('SELECT title FROM tasks WHERE id=1').get().title,'[Материал удалён] Доработать материал');
});
test('CF5-R: отказ пометки задачи откатывает карточку, историю и сохранённые заголовки',t=>{
 const {db,api,post:p}=fixture(t);linkedTasks(db,p.id);
 db.exec("CREATE TRIGGER fail_task_mark BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'task write refused'); END;");
 assert.throws(()=>api.archive(p.id,'qa',{revision:p.revision}),/task write refused/);
 assert.equal(api.get(p.id,'qa').archive.archivedAt,null);assert.equal(api.get(p.id,'qa').revision,p.revision);
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_recovery_task_marks').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_recovery_events').get().n,0);
 assert.equal(db.prepare('SELECT title FROM tasks WHERE id=1').get().title,'Доработать материал');
});
test('CF5: подключённый API скрывает архив и запрещает мутации до восстановления',async t=>{
 const {db,api,post:p}=fixture(t);
 const a=api.archive(p.id,'qa',{revision:p.revision},{userId:1});
 assert.ok(a.archive.archivedAt);assert.equal(api.list('qa').posts.length,0);assert.equal(api.archived('qa').posts.length,1);
 assert.equal(api.get(p.id,'qa').archive.archivedAt,a.archive.archivedAt);
 for(const mutate of [()=>api.update(p.id,'qa',{revision:a.revision,text:'Нельзя'}),()=>api.approve(p.id,'qa',{revision:a.revision,approved:true}),()=>api.reject(p.id,'qa',{revision:a.revision,comment:'Нельзя'}),()=>api.submitReview(p.id,'qa',{revision:a.revision}),()=>api.cancel(p.id,'qa',{revision:a.revision})])
   assert.throws(mutate,e=>e.details.code==='POST_ARCHIVED');
 await assert.rejects(api.schedule(p.id,'qa',{revision:a.revision}),e=>e.details.code==='POST_ARCHIVED');
 assert.throws(()=>api.reorder('qa',{ids:[p.id]}));
 const calendar=await api.calendar('qa',{from:'2026-10-01',to:'2026-10-31'});
 assert.ok(!JSON.stringify(calendar).includes('Черновик'));
 const restored=api.restore(p.id,'qa',{revision:a.revision});
 assert.equal(restored.archive.archivedAt,null);assert.equal(api.list('qa').posts.length,1);assert.equal(restored.approval.approved,false);
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_recovery_events').get().n,2);
});


test('CF5: архивация во время ожидания настроек не даёт позднему schedule вернуть пост в очередь',async t=>{
 const {api,post:p,transport,db}=fixture(t);let release,entered;
 const ready=new Promise(r=>{entered=r});
 transport.getSettings=()=>{entered();return new Promise(r=>{release=r})};
 const scheduling=api.schedule(p.id,'qa',{revision:p.revision});
 await ready;
 api.archive(p.id,'qa',{revision:p.revision});
 release({channels:[]});
 await assert.rejects(scheduling,e=>e.details.code==='POST_ARCHIVED');
 const row=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(p.id);
 assert.ok(row.archived_at);assert.equal(row.status,'draft');
 assert.equal(db.prepare('SELECT count(*) n FROM autoposting_deliveries').get().n,0);
});
test('CF5: архив фильтруется до ограничения списка, активная карточка не исчезает',t=>{
 const {api,db,post:p}=fixture(t);
 // Синтетический объём проверяет SQL LIMIT, без двухсот вызовов бизнес-команд.
 const insert=db.prepare(`INSERT INTO autoposting_posts(company_id,revision,status,title,text,media_urls,platform_ids,timezone,profile_revision,created_at,updated_at,archived_at,sort_order) VALUES(1,1,'draft','Архив','','[]','[]','UTC',1,'2026-10-01','2026-10-01','2026-10-01',-1)`);
 for(let n=0;n<205;n++)insert.run();
 assert.deepEqual(api.list('qa').posts.map(x=>x.id),[p.id]);
 assert.equal(api.archived('qa').posts.length,200);
});

test('CF5: worker после ожидания настроек не захватывает отменённый и архивированный черновик',async t=>{
 const {api,post:p,transport,db}=fixture(t);let release,entered,sends=0;
 db.prepare("UPDATE autoposting_posts SET status='scheduled',scheduled_at='2020-01-01T00:00:00Z' WHERE id=?").run(p.id);
 db.prepare("INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status) VALUES(?,'telegram',1,'pending')").run(p.id);
 const ready=new Promise(r=>{entered=r});transport.getSettings=()=>{entered();return new Promise(r=>{release=r})};transport.publish=async()=>{sends++;return {externalId:'unexpected'}};
 const working=api.drain();await ready;
 const cancelled=api.cancel(p.id,'qa',{revision:p.revision});api.archive(p.id,'qa',{revision:cancelled.revision});
 release({channels:[{id:'telegram',enabled:true,connected:true,revision:1}]});await working;
 assert.equal(sends,0);assert.ok(api.get(p.id,'qa').archive.archivedAt);
 assert.equal(db.prepare('SELECT status FROM autoposting_deliveries WHERE post_id=?').get(p.id).status,'cancelled');
});
