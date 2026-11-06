'use strict';
// «Задачи» сотрудника: та же доска tasks, отфильтрованная по человеку.
// Личный порядок, пауза и «Удалённые» хранятся отдельно и не стирают задачу доски.
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const RANK={urgent:0,high:1,normal:2,low:3};
const SYSTEM_SOURCES=new Set(['claude','gpt','chat','telegram','pipeline']);
const {assigneeMatches}=require('./people-assignee');
function migratePeopleBoard(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS people_task_prefs (
    company_code TEXT NOT NULL, user_id INTEGER NOT NULL, task_id INTEGER NOT NULL REFERENCES tasks(id),
    position INTEGER, paused_at TEXT, deleted_at TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(company_code,user_id,task_id));
    CREATE TABLE IF NOT EXISTS people_task_comment_receipts (
      client_ref TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), comment_id INTEGER NOT NULL);`);
}
function createPeopleBoard({db,view,now=()=>new Date().toISOString()}) {
  migratePeopleBoard(db);
  const rows=code=>db.prepare('SELECT * FROM tasks WHERE company_code=? COLLATE NOCASE AND is_deleted=0 ORDER BY id').all(code);
  // Назначение человеку (person:<id> или имя/логин этого человека): прямое или унаследованное от ветки;
  // роль owner не расширяет «мои задачи».
  function assigned(row,map,actor,code) {
    const seen=new Set();
    while(row&&!seen.has(row.id)&&String(row.company_code).toLowerCase()===code) {
      seen.add(row.id);
      if(row.assignee_name)return assigneeMatches(row.assignee_name,actor);
      row=map.get(row.parent_task_id);
    }
    return false;
  }
  // Поставлено этим человеком через Хью: «Хью, сделай …» или «Хью, поставь задачу …».
  const viaHugh=(row,userId,code)=>typeof row.client_ref==='string'&&
    (row.client_ref.startsWith(`hugh:${code}:${userId}:`)&&row.assignee_name==='Хью'&&row.created_by===String(userId)||
     row.client_ref.startsWith(`team-chat:${code}:${userId}:`)&&row.assignee_name===`person:${userId}`);
  function scope(code,actor) {
    const all=rows(code),map=new Map(all.map(r=>[r.id,r])),userId=actor.userId;
    const prefs=new Map(db.prepare('SELECT * FROM people_task_prefs WHERE company_code=? AND user_id=?').all(code,userId).map(p=>[p.task_id,p]));
    const items=all.filter(r=>viaHugh(r,userId,code)||assigned(r,map,actor,code)).map(row=>({row,section:viaHugh(row,userId,code)?'hugh':'assigned',pref:prefs.get(row.id)}));
    return {items,byId:new Map(items.map(i=>[i.row.id,i]))};
  }
  function item({row,section,pref}) {
    return {...view(row),section,from:section==='hugh'?'me':SYSTEM_SOURCES.has(row.source)?'system':'manager',
      paused:Boolean(pref?.paused_at),pausedAt:pref?.paused_at||'',deletedAt:pref?.deleted_at||'',position:pref?.position??null};
  }
  const order=(a,b)=>(a.position??1e9)-(b.position??1e9)||(['done','cancelled'].includes(a.status)-['done','cancelled'].includes(b.status))||
    (RANK[a.priority]??2)-(RANK[b.priority]??2)||a.id-b.id;
  function board(code,actor) {
    const list=scope(code,actor).items.map(item);
    const live=list.filter(t=>!t.deletedAt);
    return {companyCode:code,assigned:live.filter(t=>t.section==='assigned').sort(order),hugh:live.filter(t=>t.section==='hugh').sort(order),
      deleted:list.filter(t=>t.deletedAt).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt))};
  }
  function upsert(code,userId,taskId,fields) {
    const stamp=now(),old=db.prepare('SELECT * FROM people_task_prefs WHERE company_code=? AND user_id=? AND task_id=?').get(code,userId,taskId);
    const next={position:old?.position??null,paused_at:old?.paused_at??null,deleted_at:old?.deleted_at??null,...fields};
    db.prepare(`INSERT INTO people_task_prefs VALUES(?,?,?,?,?,?,?) ON CONFLICT(company_code,user_id,task_id)
      DO UPDATE SET position=excluded.position,paused_at=excluded.paused_at,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at`)
      .run(code,userId,taskId,next.position,next.paused_at,next.deleted_at,stamp);
    return old;
  }
  const note=(taskId,userId,text)=>db.prepare('INSERT INTO task_comments(task_id,author,text,created_at) VALUES(?,?,?,?)').run(taskId,`person:${userId}`,text,now());
  function action(code,actor,body) {
    if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Некорректное действие');
    const op=body.op,keys=Object.keys(body).sort().join(',');
    db.exec('BEGIN IMMEDIATE');
    try {
      const {byId}=scope(code,actor),userId=actor.userId;
      if(op==='order') {
        if(keys!=='op,order,section'||!['assigned','hugh'].includes(body.section)||!Array.isArray(body.order)||!body.order.length||body.order.length>500||
          new Set(body.order).size!==body.order.length||body.order.some(id=>!Number.isSafeInteger(id)))fail(400,'Передайте порядок задач раздела');
        // Порядок задаёт только сам человек и только внутри своего раздела.
        for(const id of body.order){const it=byId.get(id);if(!it||it.section!==body.section||it.pref?.deleted_at)fail(404,'Задача не найдена');}
        body.order.forEach((id,index)=>upsert(code,userId,id,{position:index}));
      } else if(['pause','resume','delete','restore'].includes(op)) {
        if(keys!=='op,taskId'||!Number.isSafeInteger(body.taskId))fail(400,'Укажите задачу');
        const it=byId.get(body.taskId);if(!it)fail(404,'Задача не найдена');
        const deleted=Boolean(it.pref?.deleted_at),paused=Boolean(it.pref?.paused_at);
        if(op!=='restore'&&deleted)fail(409,'Задача в «Удалённых». Сначала верните её');
        const stamp=now();
        if(op==='pause'&&!paused){upsert(code,userId,it.row.id,{paused_at:stamp});note(it.row.id,userId,'Поставил(а) задачу на паузу в своём списке.');}
        if(op==='resume'&&paused){upsert(code,userId,it.row.id,{paused_at:null});note(it.row.id,userId,'Снял(а) задачу с паузы.');}
        // Мягкое удаление: задача доски, история и комментарии остаются.
        if(op==='delete'){upsert(code,userId,it.row.id,{deleted_at:stamp});note(it.row.id,userId,'Убрал(а) задачу в «Удалённые» своего списка. Данные задачи сохранены.');}
        if(op==='restore'&&deleted){upsert(code,userId,it.row.id,{deleted_at:null});note(it.row.id,userId,'Вернул(а) задачу из «Удалённых».');}
      } else fail(400,'Неизвестное действие');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return board(code,actor);
  }
  // Уточнение из чата по задаче → комментарий задачи. Повтор того же сообщения не дублирует запись.
  function comment(code,actor,body) {
    if(!body||Object.keys(body).sort().join(',')!=='messageId,taskId,text'||!Number.isSafeInteger(body.taskId)||!Number.isSafeInteger(body.messageId)||
      body.messageId<1||typeof body.text!=='string'||!body.text.trim()||body.text.length>8000)fail(400,'Проверьте уточнение');
    const ref=`people-comment:${code}:${actor.userId}:${body.messageId}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const it=scope(code,actor).byId.get(body.taskId);if(!it)fail(404,'Задача не найдена');
      const receipt=db.prepare('SELECT * FROM people_task_comment_receipts WHERE client_ref=?').get(ref);
      if(receipt&&receipt.task_id!==body.taskId)fail(409,'Источник уже использован');
      const id=receipt?receipt.comment_id:Number(note(it.row.id,actor.userId,`Уточнение из чата с Хью: ${body.text.trim()}`).lastInsertRowid);
      if(!receipt)db.prepare('INSERT INTO people_task_comment_receipts VALUES(?,?,?)').run(ref,body.taskId,id);
      db.exec('COMMIT');
      return {comment:db.prepare('SELECT id,task_id,author,text,created_at FROM task_comments WHERE id=?').get(id)};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {board,action,comment};
}
module.exports={createPeopleBoard,migratePeopleBoard};
