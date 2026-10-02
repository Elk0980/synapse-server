'use strict';
const {object,text,fail}=require('./company-information');
function normalizeNotes(value,media){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>30)fail(400,'Допускается не более 30 замечаний');
  return value.map(note=>{
    object(note,['category','comment','timingKind','startMs','endMs','mediaIndex']);
    if(!['visual','music','text','other'].includes(note.category))fail(400,'Укажите категорию замечания');
    const timingKind=note.timingKind??'whole';
    if(!['whole','material','editing_wish'].includes(timingKind))fail(400,'Укажите тип привязки времени');
    const startMs=note.startMs??null,endMs=note.endMs??null,mediaIndex=note.mediaIndex??null;
    for(const time of [startMs,endMs])if(time!==null&&(!Number.isSafeInteger(time)||time<0||time>86400000))fail(400,'Время должно быть в пределах суток');
    if(mediaIndex!==null&&(!Number.isInteger(mediaIndex)||mediaIndex<0||mediaIndex>=media.length))fail(400,'Файл не найден в этой версии');
    if(timingKind==='whole'&&(startMs!==null||endMs!==null))fail(400,'Для замечания ко всему материалу время не требуется');
    if(timingKind!=='whole'&&startMs===null)fail(400,'Укажите момент замечания');
    if(endMs!==null&&(startMs===null||endMs<startMs))fail(400,'Конец интервала раньше начала');
    if(timingKind==='material'&&mediaIndex===null)fail(400,'Выберите файл для отметки времени');
    return {category:note.category,comment:text(note.comment,2000,true),timingKind,startMs,endMs,mediaIndex,durationVerified:false};
  });
}
function createReviewNotes(db){
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_review_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),content_revision INTEGER NOT NULL,
    media_urls TEXT NOT NULL,media_sha256 TEXT NOT NULL,annotations TEXT NOT NULL,
    actor_id INTEGER,actor_name TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS autoposting_review_notes_post ON autoposting_review_notes(post_id,id);`);
  return {
    save(row,notes,actor,at){if(!notes.length)return;
      db.prepare(`INSERT INTO autoposting_review_notes(post_id,company_id,content_revision,media_urls,media_sha256,annotations,actor_id,actor_name,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id,row.company_id,row.content_revision,row.media_urls,row.media_sha256||'',JSON.stringify(notes),actor.userId??null,actor.userName??null,at);
    },
    listMany(rows,companyId){
      const result=new Map(rows.map(row=>[row.id,[]]));if(!rows.length)return result;
      const ids=rows.map(row=>row.id);
      for(let offset=0;offset<ids.length;offset+=200){const part=ids.slice(offset,offset+200);
        const values=db.prepare(`SELECT post_id postId,id,content_revision contentRevision,media_urls mediaUrls,media_sha256 mediaSha256,
          annotations,actor_id actorId,actor_name actorName,created_at createdAt FROM autoposting_review_notes
          WHERE company_id=? AND post_id IN (${part.map(()=>'?').join(',')}) ORDER BY id`).all(companyId,...part);
        for(const {postId,...item} of values)result.get(postId).push({...item,mediaUrls:JSON.parse(item.mediaUrls),annotations:JSON.parse(item.annotations)});
      }return result;
    },
    list(row){return db.prepare(`SELECT id,content_revision contentRevision,media_urls mediaUrls,media_sha256 mediaSha256,
      annotations,actor_id actorId,actor_name actorName,created_at createdAt FROM autoposting_review_notes WHERE post_id=? AND company_id=? ORDER BY id`).all(row.id,row.company_id)
      .map(item=>({...item,mediaUrls:JSON.parse(item.mediaUrls),annotations:JSON.parse(item.annotations)}));}
  };
}
module.exports={normalizeNotes,createReviewNotes};
