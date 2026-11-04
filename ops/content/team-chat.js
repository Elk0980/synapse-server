'use strict';
const fail = (status, message) => { throw Object.assign(Error(message), {status}); };
const taskTitle = text => /^(?:Хью\s*[,!:]?\s*)?поставь\s+задачу\s*[:—-]?\s+([\s\S]+)$/iu.exec(text)?.[1]?.trim() || '';
function createTeamChat({db,tasks,call}) {
  // A separate audience: project_chat_* includes clients and Telegram bindings.
  db.exec(`CREATE TABLE IF NOT EXISTS team_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, user_id INTEGER NOT NULL,
    author_name TEXT NOT NULL, text TEXT NOT NULL, client_id TEXT NOT NULL, created_at TEXT NOT NULL,
    task_id INTEGER, command_state TEXT NOT NULL DEFAULT 'none',
    UNIQUE(company_code,user_id,client_id));
    CREATE INDEX IF NOT EXISTS team_chat_project_idx ON team_chat_messages(company_code,id);`);
  const running = new Map();
  function list(userId,code,before) {
    tasks.access(userId,code);
    const cursor = before == null ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail(400,'Некорректная страница');
    const rows = db.prepare('SELECT * FROM team_chat_messages WHERE company_code=? AND id<? ORDER BY id DESC LIMIT 101').all(code,cursor);
    return {messages:rows.slice(0,100).reverse(),hasMore:rows.length>100};
  }
  async function send(userId,code,body) {
    let user = tasks.access(userId,code,true);
    if (!body || Object.keys(body).sort().join(',') !== 'clientMessageId,text' || typeof body.text !== 'string' ||
        !body.text.trim() || body.text.length > 8000 || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(body.clientMessageId)) fail(400,'Проверьте сообщение');
    const text = body.text.trim(), title = taskTitle(text);
    if (title.length > 1000) fail(400,'Название задачи слишком длинное');
    let row = db.prepare('SELECT * FROM team_chat_messages WHERE company_code=? AND user_id=? AND client_id=?').get(code,userId,body.clientMessageId);
    if (row && row.text !== text) fail(409,'Идентификатор уже использован');
    if (!row) {
      const id = db.prepare('INSERT INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,command_state) VALUES(?,?,?,?,?,?,?)')
        .run(code,userId,user.displayName,text,body.clientMessageId,new Date().toISOString(),title?'pending':'none').lastInsertRowid;
      row = db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(id);
    }
    if (title && row.command_state !== 'done') {
      if (!running.has(row.id)) {
        const work = (async () => {
          user = tasks.access(userId,code,true);
          const result = await call('teamChatTask',{messageId:row.id,title},user,code);
          if (!result.task || result.task.company_code !== code || result.task.assignee_name !== `person:${userId}`) fail(502,'Неверный ответ источника');
          db.prepare("UPDATE team_chat_messages SET task_id=?,command_state='done' WHERE id=?").run(result.task.id,row.id);
        })();
        running.set(row.id,work);
        work.finally(()=>running.delete(row.id)).catch(()=>{});
      }
      await running.get(row.id);
    }
    tasks.access(userId,code,true);
    return {message:db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(row.id)};
  }
  return {list,send};
}
module.exports = {createTeamChat,taskTitle};
