'use strict';
// specs/235: сбой системы — обычная задача CRM, отдельно от просьб монтажёру и личного чата.
const {company,fail,object,text}=require('./company-information');
function createReelProblems(db,{core}){
  db.exec(`CREATE TABLE IF NOT EXISTS reel_problem_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
    reel_id INTEGER NOT NULL REFERENCES reel_materials(id), version INTEGER,
    client_request_id TEXT NOT NULL, author_id TEXT NOT NULL, task_id INTEGER NOT NULL REFERENCES tasks(id),
    created_at TEXT NOT NULL, UNIQUE(company_id,client_request_id));`);
  const list=(owner,id)=>db.prepare('SELECT task_id taskId,version,created_at createdAt FROM reel_problem_reports WHERE company_id=? AND reel_id=? ORDER BY id').all(owner.id,id);
  function report(code,id,body,actor){
    const owner=company(db,code),reel=core.full(owner,id);
    object(body,['clientRequestId','text','version']);
    const key=text(body.clientRequestId??'',70,true),message=text(body.text??'',1500,true),author=String(actor?.userId??'');
    return core.transaction(()=>{
      const repeat=db.prepare('SELECT * FROM reel_problem_reports WHERE company_id=? AND client_request_id=?').get(owner.id,key);
      if(repeat){
        if(repeat.reel_id!==id||repeat.author_id!==author)fail(409,'Ключ запроса уже использован');
        return {taskId:repeat.task_id,duplicate:true};
      }
      const version=body.version===undefined?(reel.currentVersion?.version??null):body.version;
      if(version!==null&&(!Number.isSafeInteger(version)||!reel.versions.some(v=>v.version===version)))fail(400,'Версия ролика не найдена');
      const at=new Date().toISOString(),name=text(String(actor?.userName||''),200),
        link=`https://synapse.synapsebusiness.ru/cabinet.html?companyCode=${encodeURIComponent(owner.code.toLowerCase())}#content/materials/reel/${id}`;
      const taskId=Number(db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code,assignee_role,assignee_name,status,source,source_ref,source_author,created_by)
        VALUES(?,?,?,?,?,'synapse','Claude','inbox','manual',?,?,?)`).run(at,at,`Монтаж: проблема — ${reel.title}`.slice(0,200),
        `${message}\n\nКомпания: ${owner.name||owner.code} (${owner.code}).\nРолик: №${id} «${reel.title}».\nВерсия: ${version===null?'нет':'v'+version}.\nАвтор: ${name||'#'+author} (№${author}).\n${link}`,
        owner.code,`reel-problem:${owner.id}:${key}`,name,author).lastInsertRowid);
      db.prepare('INSERT INTO reel_problem_reports(company_id,reel_id,version,client_request_id,author_id,task_id,created_at) VALUES(?,?,?,?,?,?,?)').run(owner.id,id,version,key,author,taskId,at);
      return {taskId,duplicate:false};
    });
  }
  return {list,report};
}
module.exports={createReelProblems};
