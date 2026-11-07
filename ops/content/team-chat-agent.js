'use strict';
/* specs/227: ответы агента владельца в «Чатах» кабинета — «Лео · Claude» / «Хью · Claude».

   Агент (Claude) работает через сессию владельца: читает обращения к персоне (inbox)
   и публикует ответ (reply). Прав не добавляется: комната проверяется той же функцией,
   что при обычном чтении/отправке владельцем (чужой лог с Хью и чужой личный чат закрыты). */
const {addressedPersona} = require('./hugh-personas');
const fail = (status, message) => { throw Object.assign(Error(message), {status}); };
const AUTHOR = Object.freeze({leo:'Лео · Claude', hugh:'Хью · Claude'});
const PERSONAS = Object.keys(AUTHOR);
const DAY = 864e5, INBOX_DAYS = 7, INBOX_LIMIT = 50, BATCH = 200;
// Запасные ответы, которые заменяет ответ агента; история не удаляется — меняется только статус.
const FALLBACK = ['pending','review_required','agent_pending'];

function createTeamChatAgent({db, chat, now = () => new Date().toISOString()}) {
  const owner = (userId, code, roomName, write = false) => {
    const scope = chat.scope(userId, code, roomName, write);
    if (scope.user.role !== 'owner') fail(403, 'Доступно владельцу');
    return scope;
  };
  const answersTable = () => { try { db.prepare('SELECT 1 FROM team_chat_answers LIMIT 0').all(); return true; } catch { return false; } };
  const byId = id => db.prepare('SELECT * FROM team_chat_messages WHERE id=?').get(id);
  const view = row => { const meta = db.prepare('SELECT persona,message_id FROM team_chat_agent_replies WHERE reply_id=?').get(row.id);
    return {...row, agentReply:{persona:meta.persona, replyTo:meta.message_id ?? null}}; };

  function reply(userId, code, body) {
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    if (!['room','text','persona','clientId'].every(k => keys.includes(k)) || keys.some(k => !['room','text','persona','clientId','replyTo'].includes(k)) ||
        typeof body.room !== 'string' || typeof body.text !== 'string' || !PERSONAS.includes(body.persona) ||
        typeof body.clientId !== 'string' || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(body.clientId) ||
        body.replyTo !== undefined && (!Number.isSafeInteger(body.replyTo) || body.replyTo < 1)) fail(400, 'Проверьте ответ');
    const text = body.text.trim();
    if (!text || text.length > 2000) fail(400, 'Ответ — от 1 до 2000 символов');
    const scope = owner(userId, code, body.room, true);
    const replyTo = body.replyTo ?? null;
    if (replyTo) {
      const source = byId(replyTo);
      // Чужая компания, другая комната, ответ ассистента или скрытое от владельца — одинаково 403 (без подсказки о существовании).
      if (!source || source.company_code !== code || source.room !== scope.room || source.user_id === 0 ||
          source.audience_id != null && source.audience_id !== userId) fail(403, 'Сообщение недоступно');
    }
    const clientId = `agent:${body.clientId}`, author = AUTHOR[body.persona];
    db.exec('BEGIN IMMEDIATE');
    try {
      let row = db.prepare('SELECT * FROM team_chat_messages WHERE company_code=? AND user_id=0 AND client_id=?').get(code, clientId);
      if (row) {
        const meta = db.prepare('SELECT * FROM team_chat_agent_replies WHERE reply_id=?').get(row.id);
        if (!meta || row.text !== text || row.room !== scope.room || row.author_name !== author || (meta.message_id ?? null) !== replyTo) fail(409, 'Идентификатор уже использован');
        db.exec('COMMIT');
        return {message:view(row), created:false};
      }
      const id = Number(db.prepare(`INSERT INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,room,kind)
        VALUES(?,0,?,?,?,?,?,'agent-reply')`).run(code, author, text, clientId, now(), scope.room).lastInsertRowid);
      db.prepare('INSERT INTO team_chat_agent_replies(reply_id,message_id,persona,owner_id,created_at) VALUES(?,?,?,?,?)').run(id, replyTo, body.persona, userId, now());
      if (replyTo && answersTable())
        db.prepare(`UPDATE team_chat_answers SET status='agent_answered',checked_at=? WHERE message_id=? AND status IN (${FALLBACK.map(() => '?').join(',')})`).run(now(), replyTo, ...FALLBACK);
      db.exec('COMMIT');
      row = byId(id);
      return {message:view(row), created:true};
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  function inbox(userId, code, {persona, since} = {}) {
    if (!PERSONAS.includes(persona)) fail(400, 'Укажите персону: leo или hugh');
    const cursor = since == null || since === '' ? 0 : Number(since);
    if (!Number.isSafeInteger(cursor) || cursor < 0) fail(400, 'Некорректный since');
    owner(userId, code, 'common');
    const from = new Date(Date.parse(now()) - INBOX_DAYS * DAY).toISOString();
    const readable = new Map();
    const canRead = room => { if (!readable.has(room)) { try { owner(userId, code, room); readable.set(room, true); } catch { readable.set(room, false); } } return readable.get(room); };
    const fallback = answersTable() ? db.prepare('SELECT status FROM team_chat_answers WHERE message_id=?') : null;
    const page = db.prepare(`SELECT m.* FROM team_chat_messages m WHERE m.company_code=? AND m.id>? AND m.user_id<>0 AND m.created_at>=?
      AND (m.audience_id IS NULL OR m.audience_id=?) AND (m.room='common' OR m.room=? OR m.room LIKE 'dm:%')
      AND NOT EXISTS (SELECT 1 FROM team_chat_agent_replies r WHERE r.message_id=m.id) ORDER BY m.id LIMIT ${BATCH}`);
    const messages = []; let last = cursor;
    for (;;) {
      const rows = page.all(code, last, from, userId, `hugh:${userId}`);
      for (const row of rows) {
        last = row.id;
        if (!canRead(row.room) || addressedPersona(row.text, {addressed:row.room.startsWith('hugh:')}) !== persona) continue;
        messages.push({id:row.id, room:row.room, userId:row.user_id, authorName:row.author_name, text:row.text, createdAt:row.created_at,
          kind:row.kind, persona, fallbackStatus:fallback?.get(row.id)?.status ?? null});
        if (messages.length === INBOX_LIMIT) break;
      }
      if (messages.length === INBOX_LIMIT || rows.length < BATCH) break;
    }
    // nextSince — последний просмотренный id: повтор с ним не вернёт уже показанное.
    return {persona, since:cursor, nextSince:messages.length === INBOX_LIMIT ? messages.at(-1).id : Math.max(cursor, last), messages};
  }
  return {reply, inbox};
}
module.exports = {createTeamChatAgent, AUTHOR};
