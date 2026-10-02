'use strict';
const {fail}=require('./company-information');
/* Вызывать внутри той же транзакции, что меняет archived_at, по свежему снимку БД.
   Отмена очереди не доказывает отмену уже принятой провайдером публикации. */
function assertRecoverableDraft(row,deliveries,receipts){
  if(row.archived_at)fail(409,'Карточка уже удалена. Откройте восстановление.','POST_ARCHIVED');
  if(row.status==='scheduled')fail(409,'Сначала снимите публикацию с расписания','ARCHIVE_SCHEDULED');
  if(!['draft','failed','cancelled'].includes(row.status))fail(409,'Сначала проверьте результат отправки на площадке','ARCHIVE_UNSAFE');
  if(receipts.length)fail(409,'Историю опубликованного материала нельзя удалить как черновик','ARCHIVE_PUBLISHED');
  if(deliveries.some(d=>!['cancelled','failed'].includes(d.status)||d.provider_post_id||d.external_id||d.url||d.provider_status))
    fail(409,'У материала есть незавершённая или подтверждённая отправка','ARCHIVE_UNSAFE');
}
module.exports={assertRecoverableDraft};

/* Инициализация вызывается после создания таблиц публикаций; команды работают атомарно. */
function createRecovery(db,{now=Date.now}={}){
  const {company,object,revision}=require('./company-information');
  const columns=new Set(db.prepare('PRAGMA table_info(autoposting_posts)').all().map(x=>x.name));
  for(const [name,type]of [['archived_at','TEXT'],['archived_by','INTEGER']])if(!columns.has(name))db.exec(`ALTER TABLE autoposting_posts ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_recovery_events (
    id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),company_id INTEGER NOT NULL REFERENCES companies(id),
    action TEXT NOT NULL CHECK(action IN ('archived','restored')),revision INTEGER NOT NULL,actor_id INTEGER,created_at TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_recovery_task_marks (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id),post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),original_title TEXT NOT NULL,marked_title TEXT NOT NULL);`);
  function markTasks(row,owner,at,restore){
    const table=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    if(!table('tasks')||!table('autoposting_review_tasks'))return;
    if(restore){
      // Возвращаем лишь нашу неизменённую пометку; ручные правки, перемещение и удаление задачи сохраняются.
      for(const mark of db.prepare('SELECT * FROM autoposting_recovery_task_marks WHERE post_id=? AND company_id=?').all(row.id,owner.id)){
        db.prepare(`UPDATE tasks SET title=?,updated_at=? WHERE id=? AND title=? AND company_code=? COLLATE NOCASE AND is_deleted=0`)
          .run(mark.original_title,at,mark.task_id,mark.marked_title,owner.code);
      }
      db.prepare('DELETE FROM autoposting_recovery_task_marks WHERE post_id=? AND company_id=?').run(row.id,owner.id);
      return;
    }
    const tasks=db.prepare(`SELECT t.id,t.title FROM autoposting_review_tasks l JOIN tasks t ON t.id=l.task_id
      WHERE l.post_id=? AND l.company_id=? AND t.company_code=? COLLATE NOCASE AND t.is_deleted=0`).all(row.id,owner.id,owner.code);
    for(const task of tasks){
      const marked=`[Материал удалён] ${task.title}`.slice(0,200);
      db.prepare('INSERT INTO autoposting_recovery_task_marks(task_id,post_id,company_id,original_title,marked_title) VALUES(?,?,?,?,?)')
        .run(task.id,row.id,owner.id,task.title,marked);
      db.prepare('UPDATE tasks SET title=?,updated_at=? WHERE id=?').run(marked,at,task.id);
    }
  }
  function change(id,code,body,actor,restore){
    object(body,['revision']);revision(body.revision);
    if(!Number.isSafeInteger(Number(id))||Number(id)<1)fail(404,'Публикация не найдена','NOT_FOUND');
    db.exec('BEGIN IMMEDIATE');
    try{
      const owner=company(db,code),row=db.prepare('SELECT * FROM autoposting_posts WHERE id=? AND company_id=?').get(Number(id),owner.id);
      if(!row)fail(404,'Публикация не найдена','NOT_FOUND');
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      const deliveries=db.prepare('SELECT * FROM autoposting_deliveries WHERE post_id=?').all(row.id);
      const receipts=db.prepare('SELECT id FROM autoposting_publication_receipts WHERE post_id=?').all(row.id);
      if(restore){
        if(!row.archived_at)fail(409,'Карточка не удалена','POST_NOT_ARCHIVED');
        // Повторная проверка защищает от появившегося внешнего результата после архивации.
        assertRecoverableDraft({...row,archived_at:null},deliveries,receipts);
      }else assertRecoverableDraft(row,deliveries,receipts);
      const at=new Date(now()).toISOString();
      db.prepare(`UPDATE autoposting_posts SET archived_at=?,archived_by=?,status='draft',scheduled_at=NULL,
        approved_revision=NULL,approved_at=NULL,approved_by=NULL,approved_by_name=NULL,partial_approved_revision=NULL,
        review_state='draft',publishing_at=NULL,lease=NULL,revision=revision+1,updated_at=? WHERE id=? AND company_id=?`)
        .run(restore?null:at,restore?null:(actor.userId??null),at,row.id,owner.id);
      // Это текущие согласования; исторические решения и замечания сохраняются отдельно.
      db.prepare("UPDATE autoposting_platform_reviews SET state='pending' WHERE post_id=?").run(row.id);
      markTasks(row,owner,at,restore);
      db.prepare(`INSERT INTO autoposting_recovery_events(post_id,company_id,action,revision,actor_id,created_at) VALUES(?,?,?,?,?,?)`)
        .run(row.id,owner.id,restore?'restored':'archived',row.revision+1,actor.userId??null,at);
      const result=db.prepare('SELECT * FROM autoposting_posts WHERE id=? AND company_id=?').get(row.id,owner.id);
      db.exec('COMMIT');return result;
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  return {archive:(id,code,body,actor={})=>change(id,code,body,actor,false),restore:(id,code,body,actor={})=>change(id,code,body,actor,true)};
}
module.exports.createRecovery=createRecovery;
