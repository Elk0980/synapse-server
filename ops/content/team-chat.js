'use strict';
const fail = (status, message) => { throw Object.assign(Error(message), {status}); };
const taskTitle = text => /^(?:Хью\s*[,!:]?\s*)?поставь\s+задачу\s*[:—-]?\s+([\s\S]+)$/iu.exec(text)?.[1]?.trim() || '';
// Хью пишет только при обращении: «Хью, …» в начале или упоминание «@Хью».
const addressed = text => /^\s*@?хью(?![\p{L}\p{N}])/iu.test(text) || /(?<![\p{L}\p{N}])@хью(?![\p{L}\p{N}])/iu.test(text);
// Лео (specs/227) — так же только по обращению: «Лео, …» в начале или «@Лео». Отвечает агент владельца.
const leoAddressed = text => /^\s*@?(?:лео|leo)(?![\p{L}\p{N}])/iu.test(text) || /(?<![\p{L}\p{N}])@(?:лео|leo)(?![\p{L}\p{N}])/iu.test(text);
const {detect} = require('./hugh-personas');
// «Хью, сделай …» → задача «Я поставил Хью». В личном чате с Хью обращение подразумевается.
function hughTitle(text, implicit=false) {
  const match = /^\s*(@?хью\s*[,!:]?\s*)?((?:сделай(?:те)?|измени(?:те)?|поменяй(?:те)?|исправь(?:те)?|добавь(?:те)?|убери(?:те)?|подготовь(?:те)?|перенеси(?:те)?)\s+[\s\S]+)$/iu.exec(text);
  if (!match || !match[1] && !implicit) return '';
  const title = match[2].trim().replace(/\s+/g, ' ');
  return title[0].toLocaleUpperCase('ru') + title.slice(1);
}
const TOPICS = [/контент[- ]?план|план\p{L}* публикац/iu, /рилс|reels|ролик/iu, /сайт|лендинг/iu, /прайс|цен[аыуе]/iu, /монтаж/iu, /съ[её]мк/iu, /сторис|stories/iu, /пост(?:ы|ов|а)?(?![\p{L}])|публикац/iu];
const STOP = new Set(['хью','сделай','сделайте','измени','поменяй','исправь','добавь','убери','подготовь','перенеси','пожалуйста','нужно','надо','чтобы']);
function similar(a, b) {
  if (TOPICS.some(re => re.test(a) && re.test(b))) return true;
  const stems = text => new Set((text.toLocaleLowerCase('ru').match(/\p{L}{4,}/gu) || []).filter(w => !STOP.has(w)).map(w => w.slice(0, 5)));
  const x = stems(a), y = stems(b), common = [...x].filter(w => y.has(w)).length;
  return common >= 2 && common / Math.max(1, new Set([...x, ...y]).size) >= 0.5;
}
function createTeamChat({db,tasks,call,answers,unsafe=()=>false,now=()=>new Date().toISOString()}) {
  // A separate audience: project_chat_* includes clients and Telegram bindings.
  db.exec(`CREATE TABLE IF NOT EXISTS team_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, user_id INTEGER NOT NULL,
    author_name TEXT NOT NULL, text TEXT NOT NULL, client_id TEXT NOT NULL, created_at TEXT NOT NULL,
    task_id INTEGER, command_state TEXT NOT NULL DEFAULT 'none',
    UNIQUE(company_code,user_id,client_id));
    CREATE INDEX IF NOT EXISTS team_chat_project_idx ON team_chat_messages(company_code,id);`);
  // Комнаты: 'common' — общий чат компании, 'dm:a-b' — личный чат двух сотрудников, 'hugh:id' — лог человека с Хью.
  const columns = new Set(db.prepare('PRAGMA table_info(team_chat_messages)').all().map(c => c.name));
  for (const [name, type] of [['room',"TEXT NOT NULL DEFAULT 'common'"],['kind',"TEXT NOT NULL DEFAULT 'message'"],['ref_task_id','INTEGER'],['audience_id','INTEGER']])
    if (!columns.has(name)) db.exec(`ALTER TABLE team_chat_messages ADD COLUMN ${name} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS team_chat_room_idx ON team_chat_messages(company_code,room,id)');
  // specs/227: ответы агента владельца (Лео/Хью · Claude). Видны всем, кто читает комнату, как сообщение владельца.
  db.exec(`CREATE TABLE IF NOT EXISTS team_chat_agent_replies (
    reply_id INTEGER PRIMARY KEY REFERENCES team_chat_messages(id), message_id INTEGER REFERENCES team_chat_messages(id),
    persona TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS team_chat_agent_replies_message_idx ON team_chat_agent_replies(message_id);`);
  const running = new Map();
  // №127: участник «Чатов» — исполнитель своих задач (people) или любой аккаунт ЛК, которому
  // владелец открыл эту компанию с какими-либо правами (без прав — доступ отозван). Второму доступны только общий и личные чаты: без лога Хью,
  // задач и ответов Хью (для них нужен доступ к задачам). Компания проверяется здесь, на сервере.
  function chatAccess(userId, code, write=false) {
    let denied;
    try { return {...tasks.access(userId, code, write), tasksAccess:true}; } catch (error) { if (error.status !== 403) throw error; denied = error; }
    let row;
    try {
      row = db.prepare(`SELECT u.id,u.display_name,u.must_change_password FROM auth_users u
        JOIN auth_user_companies c ON c.user_id=u.id AND c.company_code=? WHERE u.id=? AND u.role='editor'
        AND EXISTS (SELECT 1 FROM auth_user_permissions p WHERE p.user_id=u.id)`).get(code, userId);
    } catch { row = null; }
    if (!row || row.must_change_password === 1) throw denied;
    return {id:row.id, displayName:row.display_name, role:'editor', tasksAccess:false};
  }
  function room(user, code, value='common') {
    if (value === 'common') return {room:value};
    let match = /^hugh:([1-9]\d{0,15})$/.exec(value);
    if (match) { if (Number(match[1]) !== user.id || !user.tasksAccess) fail(403,'Чат недоступен'); return {room:value, hugh:true}; }
    match = /^dm:([1-9]\d{0,15})-([1-9]\d{0,15})$/.exec(value);
    if (!match) fail(400,'Некорректный чат');
    const pair = [Number(match[1]), Number(match[2])];
    if (!(pair[0] < pair[1]) || !pair.includes(user.id)) fail(403,'Чат недоступен');
    try { chatAccess(pair[0] === user.id ? pair[1] : pair[0], code); } catch { fail(403,'Собеседник не работает в этой компании'); }
    return {room:value, dm:pair};
  }
  function members(userId, code) {
    const user = chatAccess(userId, code);
    let rows = [];
    try {
      rows = db.prepare(`SELECT id,display_name FROM auth_users WHERE role='owner' UNION SELECT u.id,u.display_name FROM auth_users u
        JOIN company_team_members m ON m.user_id=u.id WHERE m.company_code=? AND m.staff_role='human_executor'
        UNION SELECT u.id,u.display_name FROM auth_users u JOIN auth_user_companies c ON c.user_id=u.id WHERE c.company_code=? AND u.role='editor' ORDER BY 2`).all(code, code);
    } catch { rows = []; }
    const people = rows.filter(r => r.id !== user.id && (() => { try { chatAccess(r.id, code); return true; } catch { return false; } })())
      .map(r => ({id:r.id, name:r.display_name, room:`dm:${Math.min(r.id,user.id)}-${Math.max(r.id,user.id)}`}));
    return {viewerId:user.id, common:'common', hugh:user.tasksAccess ? `hugh:${user.id}` : null, people};
  }
  function list(userId,code,before,roomName='common') {
    const user=chatAccess(userId,code),owner=user.role==='owner',scope=room(user,code,roomName||'common');
    const cursor = before == null ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail(400,'Некорректная страница');
    // Apply audience before pagination, including already stored answers.
    const rows = answers?db.prepare(`SELECT m.* FROM team_chat_messages m
      LEFT JOIN team_chat_answers a ON a.reply_id=m.id
      LEFT JOIN team_chat_messages source ON source.id=a.message_id AND source.company_code=m.company_code
      WHERE m.company_code=? AND m.room=? AND m.id<? AND (m.audience_id IS NULL OR m.audience_id=?)
      AND (m.user_id<>0 OR m.audience_id=? OR ? OR source.user_id=? OR EXISTS (SELECT 1 FROM team_chat_agent_replies r WHERE r.reply_id=m.id))
      ORDER BY m.id DESC LIMIT 101`).all(code,scope.room,cursor,userId,userId,Number(owner),userId):
      db.prepare('SELECT * FROM team_chat_messages m WHERE company_code=? AND room=? AND id<? AND (audience_id IS NULL OR audience_id=?) AND (user_id<>0 OR audience_id=? OR ? OR EXISTS (SELECT 1 FROM team_chat_agent_replies r WHERE r.reply_id=m.id)) ORDER BY id DESC LIMIT 101')
        .all(code,scope.room,cursor,userId,userId,Number(owner));
    const agentReply = db.prepare('SELECT persona,message_id FROM team_chat_agent_replies WHERE reply_id=?');
    // Личные чаты сотрудников не попадают в очередь проверки владельца.
    const reviewQueue=answers&&owner?db.prepare(`SELECT a.message_id,a.checked_at,a.reason,m.text
      FROM team_chat_answers a JOIN team_chat_messages m ON m.id=a.message_id
      WHERE m.company_code=? AND m.room NOT LIKE 'dm:%' AND a.status='review_required' ORDER BY a.message_id DESC LIMIT 20`).all(code):undefined;
    return {room:scope.room,messages:rows.slice(0,100).reverse().map(message=>{
      const agent=message.user_id===0?agentReply.get(message.id):null;
      if(agent)message={...message,agentReply:{persona:agent.persona,replyTo:agent.message_id??null}};
      if(!answers)return message;
      const audit=db.prepare('SELECT model,review_model,checked_at,status FROM team_chat_answers WHERE reply_id=?').get(message.id);
      return audit?{...message,answerAudit:audit}:message;
    }),hasMore:rows.length>100,viewerId:user.id,visibilityKey:`${user.id}:${owner}`, ...(reviewQueue?{reviewQueue}:{} )};
  }
  const quote = (text, code) => unsafe(text, code) ? 'текст скрыт: в нём личные данные' : `«${text.replace(/\s+/g,' ').slice(0,200)}»`;
  // Хью сводит одинаковые запросы внутри компании: каждый получает в свой лог, что просил другой.
  function merge(row, user, code) {
    const since = new Date(Date.parse(row.created_at) - 14 * 864e5).toISOString();
    const others = db.prepare(`SELECT * FROM team_chat_messages WHERE company_code=? AND kind='hugh-task' AND task_id IS NOT NULL
      AND user_id NOT IN (0,?) AND created_at>=? ORDER BY id DESC LIMIT 50`).all(code, user.id, since).filter(o => similar(row.text, o.text)).slice(0, 3);
    const insert = db.prepare(`INSERT OR IGNORE INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,room,kind,audience_id,ref_task_id)
      VALUES(?,0,'Хью · ИИ',?,?,?,?,'hugh-merge',?,?)`);
    for (const other of others) {
      let peer; try { peer = tasks.access(other.user_id, code); } catch { continue; }
      insert.run(code, `Похожий запрос в проекте: ${peer.displayName} просил(а) ${quote(other.text, code)} — задача №${other.task_id}. Учту оба запроса вместе.`,
        `hugh-merge:${row.id}:${other.id}:a`, now(), `hugh:${user.id}`, user.id, other.task_id);
      insert.run(code, `${user.displayName} тоже просит ${quote(row.text, code)} — задача №${row.task_id}. Ваш запрос — задача №${other.task_id}. Учту оба вместе.`,
        `hugh-merge:${row.id}:${other.id}:b`, now(), `hugh:${other.user_id}`, other.user_id, row.task_id);
    }
  }
  function once(row, work) {
    if (!running.has(row.id)) { const job = work(); running.set(row.id, job); job.finally(() => running.delete(row.id)).catch(() => {}); }
    return running.get(row.id);
  }
  async function send(userId,code,body) {
    let user = chatAccess(userId,code,true);
    const keys = body && typeof body === 'object' ? Object.keys(body) : [];
    if (!body || !keys.includes('text') || !keys.includes('clientMessageId') || keys.some(k => !['clientMessageId','text','room','taskId'].includes(k)) ||
        typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000 || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(body.clientMessageId) ||
        body.room !== undefined && typeof body.room !== 'string' || body.taskId !== undefined && (!Number.isSafeInteger(body.taskId) || body.taskId < 1)) fail(400,'Проверьте сообщение');
    const scope = room(user, code, body.room || 'common');
    if (body.taskId && !scope.hugh) fail(400,'Чат по задаче ведётся в личном чате с Хью');
    if (body.taskId && !user.tasksAccess) fail(403,'Нет доступа к задачам');
    // Без доступа к задачам сообщение остаётся обычным: задачу не ставим, Хью не зовём.
    const text = body.text.trim(), title = body.taskId || !user.tasksAccess ? '' : taskTitle(text), request = title || body.taskId || !user.tasksAccess ? '' : hughTitle(text, scope.hugh);
    if (title.length > 1000 || request.length > 1000) fail(400,'Название задачи слишком длинное');
    let row = db.prepare('SELECT * FROM team_chat_messages WHERE company_code=? AND user_id=? AND client_id=?').get(code,userId,body.clientMessageId);
    if (row && (row.text !== text || row.room !== scope.room || (row.ref_task_id || undefined) !== body.taskId)) fail(409,'Идентификатор уже использован');
    if (!row) {
      const kind = title ? 'self-task' : request ? 'hugh-task' : body.taskId ? 'task-note' : 'message';
      const id = db.prepare('INSERT INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,command_state,room,kind,ref_task_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(code,userId,user.displayName,text,body.clientMessageId,now(),title||request||body.taskId?'pending':'none',scope.room,kind,body.taskId||null).lastInsertRowid;
      row = db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(id);
    }
    if ((title || request) && row.command_state !== 'done') {
      await once(row, async () => {
        user = tasks.access(userId,code,true);
        const result = await call(title ? 'teamChatTask' : 'hughTask',{messageId:row.id,title:title||request},user,code);
        if (!result.task || result.task.company_code !== code || result.task.assignee_name !== (title ? `person:${userId}` : 'Хью')) fail(502,'Неверный ответ источника');
        db.prepare("UPDATE team_chat_messages SET task_id=?,command_state='done' WHERE id=?").run(result.task.id,row.id);
        if (request) merge(db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(row.id), tasks.access(userId,code,true), code);
      });
    }
    if (body.taskId && row.command_state !== 'done') {
      await once(row, async () => {
        const result = await call('taskChatComment',{taskId:body.taskId,messageId:row.id,text},tasks.access(userId,code,true),code);
        if (!result.comment || result.comment.task_id !== body.taskId) fail(502,'Неверный ответ источника');
        db.prepare("UPDATE team_chat_messages SET command_state='done' WHERE id=?").run(row.id);
      });
    }
    user = chatAccess(userId,code,true);
    // Кого позвали: «Лео, …» — Лео; названы оба — тот, кто раньше (hugh-personas.detect); иначе Хью.
    const persona = leoAddressed(text) ? (addressed(text) ? detect(text) || 'hugh' : 'leo') : 'hugh';
    if(!title&&!request&&answers&&user.tasksAccess&&(scope.hugh||addressed(text)||leoAddressed(text)))await answers.answer(row,{persona});
    chatAccess(userId,code,true);
    return {message:db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(row.id)};
  }
  // Та же проверка комнаты, что при чтении/отправке (specs/227: агент владельца не получает новых комнат).
  const scope = (userId, code, roomName, write=false) => { const user = chatAccess(userId, code, write); return {user, ...room(user, code, roomName || 'common')}; };
  return {list,send,members,access:chatAccess,scope};
}
module.exports = {createTeamChat,taskTitle,hughTitle,addressed,leoAddressed,similar};
