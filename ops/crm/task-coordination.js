'use strict';

// Метаданные существующих CRM-задач. Это учёт подтверждений, не запуск агентов.
const STAGES = ['code', 'connected', 'verified', 'accepted'];
const TEXT_FIELDS = ['module', 'ownerThreadId', 'ownerThreadName', 'executorId', 'executorName',
  'verifiedModel', 'scope', 'acceptance', 'result', 'blocker', 'nextAction'];
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const text = (value, max = 2000) => {
  if (typeof value !== 'string' || value.length > max) fail(400, 'Некорректное текстовое поле');
  return value.trim();
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const date = value => {
  const parsed = typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) fail(400, 'Нужны дата и время проверки');
  return new Date(parsed).toISOString();
};
const empty = () => ({...Object.fromEntries(TEXT_FIELDS.map(key => [key, ''])), modelCheckedAt: '',
  milestones: Object.fromEntries(STAGES.map(key => [key, {state:'pending', evidence:'', checkedAt:''}]))});

function createTaskCoordination(db, {now = () => Date.now()} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_coordination (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id), revision INTEGER NOT NULL,
    data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_coordination_history (
    task_id INTEGER NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
    data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER NOT NULL,
    PRIMARY KEY(task_id,revision));
    CREATE TRIGGER IF NOT EXISTS task_coordination_history_no_update BEFORE UPDATE ON task_coordination_history
    BEGIN SELECT RAISE(ABORT,'Immutable coordination history'); END;
    CREATE TRIGGER IF NOT EXISTS task_coordination_history_no_delete BEFORE DELETE ON task_coordination_history
    BEGIN SELECT RAISE(ABORT,'Immutable coordination history'); END;`);
  const owner = actor => { if (actor?.role !== 'owner' || !Number.isSafeInteger(actor.userId) || actor.userId < 1) fail(403, 'Координация доступна владельцу'); };
  const task = id => {
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректная задача');
    const row = db.prepare('SELECT id,title,company_code,status,assignee_name FROM tasks WHERE id=? AND is_deleted=0').get(id);
    if (!row) fail(404, 'Задача не найдена');
    return row;
  };
  const entry = row => {
    const saved = db.prepare('SELECT * FROM task_coordination WHERE task_id=?').get(row.id);
    return {taskId:row.id, title:row.title, companyCode:row.company_code, taskStatus:row.status,
      assigneeName:row.assignee_name, revision:saved?.revision || 0, updatedAt:saved?.updated_at || '',
      updatedBy:saved?.updated_by || null, ...(saved ? JSON.parse(saved.data) : empty()),
      // Ручная фиксация не подтверждает активный процесс и не захватывает ресурс.
      tracking:'manual'};
  };
  const get = (id, actor) => { owner(actor); return entry(task(id)); };
  const list = (query, actor) => {
    owner(actor);
    const code = query.companyCode || '';
    if (code && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) fail(400, 'Некорректная компания');
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) fail(400, 'Некорректная страница');
    const where = 'is_deleted=0' + (code ? ' AND company_code=? COLLATE NOCASE' : '');
    const params = code ? [code] : [];
    const total = db.prepare(`SELECT count(*) n FROM tasks WHERE ${where}`).get(...params).n;
    return {tasks:db.prepare(`SELECT id,title,company_code,status,assignee_name FROM tasks WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params,limit,offset).map(entry), pagination:{total,limit,offset}};
  };
  const save = (id, body, actor) => {
    owner(actor);
    if (!object(body) || Object.keys(body).some(k => !['revision','data'].includes(k)) ||
        !Number.isSafeInteger(body.revision) || body.revision < 0 || !object(body.data)) fail(400, 'Нужны версия и данные карточки');
    const data = empty();
    if (Object.keys(body.data).some(k => ![...TEXT_FIELDS,'modelCheckedAt','milestones'].includes(k))) fail(400, 'Неизвестное поле карточки');
    for (const key of TEXT_FIELDS) if (key in body.data) data[key] = text(body.data[key], ['scope','acceptance','result','blocker','nextAction'].includes(key) ? 4000 : 200);
    if (data.ownerThreadName && !data.ownerThreadId) fail(400, 'Укажите постоянный идентификатор ответственного чата');
    if (data.verifiedModel) {
      data.modelCheckedAt = date(body.data.modelCheckedAt);
      if (Date.parse(data.modelCheckedAt) > now()) fail(400, 'Дата проверки модели находится в будущем');
    } else if (body.data.modelCheckedAt) fail(400, 'Укажите проверенную модель');
    const milestones = body.data.milestones || {};
    if (!object(milestones) || Object.keys(milestones).some(k => !STAGES.includes(k))) fail(400, 'Неизвестный этап');
    for (const key of STAGES) {
      const item = milestones[key];
      if (item === undefined) continue;
      if (!object(item) || Object.keys(item).some(k => !['state','evidence','checkedAt'].includes(k)) ||
          !['pending','confirmed','not_required'].includes(item.state)) fail(400, 'Некорректное состояние этапа');
      const evidence = text(item.evidence || '', 4000);
      const checkedAt = item.checkedAt ? date(item.checkedAt) : '';
      if (item.state !== 'pending' && (!evidence || !checkedAt)) fail(400, 'Для подтверждения или исключения этапа нужны основание и дата');
      if (checkedAt && Date.parse(checkedAt) > now()) fail(400, 'Дата проверки находится в будущем');
      data.milestones[key] = {state:item.state,evidence,checkedAt};
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = task(id);
      const old = db.prepare('SELECT revision FROM task_coordination WHERE task_id=?').get(id);
      if ((old?.revision || 0) !== body.revision) fail(409, 'Карточка изменена другим исполнителем. Обновите её перед сохранением');
      const revision = body.revision + 1, stamp = new Date(now()).toISOString(), json = JSON.stringify(data);
      db.prepare(`INSERT INTO task_coordination(task_id,revision,data,updated_at,updated_by) VALUES(?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .run(id,revision,json,stamp,actor.userId);
      db.prepare('INSERT INTO task_coordination_history VALUES(?,?,?,?,?)').run(id,revision,json,stamp,actor.userId);
      const result = entry(row);
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {get,list,save};
}
module.exports = {createTaskCoordination};
