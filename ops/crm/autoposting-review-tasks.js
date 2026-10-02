'use strict';
// Обычная задача входящих. Не создаёт task_dispatch и не отправляет уведомлений.
const categories={visual:'Изображение и видеоряд',music:'Музыка',text:'Текст',other:'Другое'};
function timeLabel(ms){const sec=Math.floor(ms/1000);return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}${ms%1000?'.'+String(ms%1000).padStart(3,'0'):''}`;}
function noteLabel(a,i){
  const time=a.startMs===null?'':`${timeLabel(a.startMs)}${a.endMs===null?'':'–'+timeLabel(a.endMs)}`;
  const where=a.timingKind==='whole'?'весь материал':a.timingKind==='material'?`файл №${a.mediaIndex+1}`:'пожелание к монтажу';
  return `${i+1}. ${categories[a.category]||'Другое'} — ${where}${time?', '+time:''}: ${a.comment}`;
}
function createReviewTasks(db){
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_review_tasks (
    post_id INTEGER NOT NULL,post_revision INTEGER NOT NULL,content_revision INTEGER NOT NULL,
    company_id INTEGER NOT NULL REFERENCES companies(id),task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
    PRIMARY KEY(post_id,post_revision));`);
  return {
    save(row,owner,comment,annotations,actor,at){
      const existing=db.prepare('SELECT task_id FROM autoposting_review_tasks WHERE post_id=? AND post_revision=?').get(row.id,row.revision);
      if(existing)return;
      const description=`Публикация №${row.id}, версия содержимого ${row.content_revision}.\n${comment}\n`+
        annotations.map(noteLabel).join('\n');
      const taskId=Number(db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code,
        assignee_role,assignee_name,status,due_date,source,source_ref,source_author,created_by)
        VALUES(?,?,?,?,?,'synapse','','inbox','','manual',?,?,?)`).run(at,at,`Доработать публикацию: ${row.title}`.slice(0,200),description,
        owner.code,`content-review:${row.id}:${row.revision}`,actor.userName||'',String(actor.userId??'')).lastInsertRowid);
      db.prepare('INSERT INTO autoposting_review_tasks VALUES(?,?,?,?,?)').run(row.id,row.revision,row.content_revision,row.company_id,taskId);
    },
    listMany(rows,companyId){
      const result=new Map(rows.map(row=>[row.id,[]]));if(!rows.length)return result;
      const ids=rows.map(row=>row.id);
      for(let offset=0;offset<ids.length;offset+=200){const part=ids.slice(offset,offset+200);
        const values=db.prepare(`SELECT l.post_id postId,t.id taskId,l.content_revision contentRevision,t.status,
          NULLIF(t.assignee_name,'') assigneeName,NULLIF(t.due_date,'') dueDate
          FROM autoposting_review_tasks l JOIN tasks t ON t.id=l.task_id JOIN companies c ON c.id=l.company_id
          WHERE l.company_id=? AND l.post_id IN (${part.map(()=>'?').join(',')}) AND t.company_code=c.code COLLATE NOCASE AND t.is_deleted=0
          ORDER BY l.post_revision DESC`).all(companyId,...part);
        for(const {postId,...item} of values)result.get(postId).push(item);
      }return result;
    },
    list(row){return db.prepare(`SELECT t.id taskId,l.content_revision contentRevision,t.status,
      NULLIF(t.assignee_name,'') assigneeName,NULLIF(t.due_date,'') dueDate
      FROM autoposting_review_tasks l JOIN tasks t ON t.id=l.task_id JOIN companies c ON c.id=l.company_id
      WHERE l.post_id=? AND l.company_id=? AND t.company_code=c.code COLLATE NOCASE AND t.is_deleted=0
      ORDER BY l.post_revision DESC`).all(row.id,row.company_id);}
  };
}
module.exports={createReviewTasks};
