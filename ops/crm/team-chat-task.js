'use strict';
const fail = (status, message) => { throw Object.assign(Error(message), {status}); };
// Narrow people capability; never presents a human as owner to the MCP API.
function createTeamChatTask(db, code, actor, body, mode = 'self') {
  if (!body || Object.keys(body).sort().join(',') !== 'messageId,title' ||
      !Number.isSafeInteger(body.messageId) || body.messageId < 1 ||
      typeof body.title !== 'string' || !body.title.trim() || body.title.length > 1000) fail(400, 'Проверьте команду');
  // mode 'hugh': «Хью, сделай …» — задача Хью, поставленная этим человеком (раздел «Я поставил Хью»).
  const hugh = mode === 'hugh', title = body.title.trim(), executor = hugh ? 'Хью' : `person:${actor.userId}`;
  const ref = `${hugh ? 'hugh' : 'team-chat'}:${code}:${actor.userId}:${body.messageId}`;
  const normalized = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
  db.exec(`CREATE TABLE IF NOT EXISTS team_chat_task_receipts (
    client_ref TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), title TEXT NOT NULL);`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const receipt = db.prepare('SELECT * FROM team_chat_task_receipts WHERE client_ref=?').get(ref);
    if (receipt && receipt.title !== title) fail(409,'Источник уже использован');
    let row = receipt ? db.prepare('SELECT * FROM tasks WHERE id=?').get(receipt.task_id) : db.prepare('SELECT * FROM tasks WHERE client_ref=?').get(ref), created = false;
    if (row && (row.is_deleted || row.company_code !== code || row.assignee_name !== executor || hugh && row.created_by !== String(actor.userId))) fail(409, 'Источник уже использован');
    if (!row) row = db.prepare("SELECT * FROM tasks WHERE company_code=? AND assignee_name=? AND is_deleted=0 AND status NOT IN ('done','cancelled') ORDER BY id").all(code, executor)
      .find(t => normalized(t.title) === normalized(title) && (!hugh || t.created_by === String(actor.userId)));
    if (!row) {
      const at = new Date().toISOString();
      const url = `https://synapse.synapsebusiness.ru/cabinet/team-chat.html?companyCode=${encodeURIComponent(code)}#message-${body.messageId}`;
      const id = Number(db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code,assignee_name,reviewer_name,priority,due_date,source,created_by,parent_task_id,client_ref,status)
        VALUES(?,?,?,?,?,?,'','normal','','manual',?,NULL,?,'inbox')`).run(at, at, title, `${hugh ? `Поставил person:${actor.userId} через чат с Хью.\n` : ''}Источник: ${url}`, code, executor, String(actor.userId), ref).lastInsertRowid);
      if (db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'chat_url')) db.prepare('UPDATE tasks SET chat_url=? WHERE id=?').run(url, id);
      const data = JSON.stringify({executorName:executor,links:[{kind:'link',label:'Открыть обсуждение',url}],milestones:Object.fromEntries(['code','connected','verified','accepted'].map(k=>[k,{state:'pending',evidence:'',checkedAt:''}]))});
      // The current CRM insert trigger already writes the initial revision.
      const old = db.prepare('SELECT revision,data FROM task_coordination WHERE task_id=?').get(id);
      const revision = (old?.revision || 0) + 1;
      const merged = JSON.stringify({...JSON.parse(old?.data || '{}'),...JSON.parse(data)});
      db.prepare(`INSERT INTO task_coordination VALUES(?,?,?,?,?) ON CONFLICT(task_id)
        DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(id, revision, merged, at, actor.userId);
      db.prepare('INSERT INTO task_coordination_history VALUES(?,?,?,?,?)').run(id, revision, merged, at, actor.userId);
      row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id); created = true;
    }
    db.prepare('INSERT OR IGNORE INTO team_chat_task_receipts VALUES(?,?,?)').run(ref,row.id,title);
    db.exec('COMMIT');
    return {task:{id:row.id,title:row.title,company_code:row.company_code,assignee_name:row.assignee_name},created};
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = {createTeamChatTask};
