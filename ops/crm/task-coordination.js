'use strict';
const {waitingSince} = require('./task-waiting');
const {hasBoardSchema,boardFields,createTaskProducts,validatedChat} = require('./task-products');
const Steps = require('./task-coordination-steps');

// Метаданные существующих CRM-задач. Это учёт подтверждений, не запуск агентов.
const STAGES = ['code', 'connected', 'verified', 'accepted'];
const PERSON_WHITESPACE = [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,
  8232,8233,8239,8287,12288,65279];
const PERSON_UPPERCASE_RU = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
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
const empty = () => ({...Object.fromEntries(TEXT_FIELDS.map(key => [key, ''])), modelCheckedAt: '', links: [],
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
    const row = db.prepare('SELECT * FROM tasks WHERE id=? AND is_deleted=0').get(id);
    if (!row) fail(404, 'Задача не найдена');
    return row;
  };
  const entry = row => {
    const saved = db.prepare('SELECT * FROM task_coordination WHERE task_id=?').get(row.id);
    return {taskId:row.id, title:row.title, companyCode:row.company_code, taskStatus:row.status,
      assigneeName:row.assignee_name, revision:saved?.revision || 0, updatedAt:saved?.updated_at || '',
      updatedBy:saved?.updated_by ?? null, ...(saved ? JSON.parse(saved.data) : empty()),
      // Ручная фиксация не подтверждает активный процесс и не захватывает ресурс.
      tracking:'manual', ...(hasMcpSchema(db) ? {...taskExtras(db, row, now()),executorName:row.assignee_name} : {})};
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
    return {tasks:db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params,limit,offset).map(entry), pagination:{total,limit,offset}};
  };
  const save = (id, body, actor) => {
    owner(actor);
    if (!object(body) || Object.keys(body).some(k => !['revision','data'].includes(k)) ||
        !Number.isSafeInteger(body.revision) || body.revision < 0 || !object(body.data)) fail(400, 'Нужны версия и данные карточки');
    const data = empty();
    const previous = db.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(id);
    data.links = previous ? JSON.parse(previous.data).links || [] : [];
    // «Точка А → Точка Б» меняется только отдельными инструментами и переносится как есть.
    const previousPointAB = previous ? JSON.parse(previous.data).pointAB : undefined;
    if (previousPointAB !== undefined) data.pointAB = previousPointAB;
    if (Object.keys(body.data).some(k => ![...TEXT_FIELDS,'modelCheckedAt','milestones','links'].includes(k))) fail(400, 'Неизвестное поле карточки');
    if ('links' in body.data) data.links = validateLinks(body.data.links);
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
    const ownTransaction = !db.isTransaction;
    if (ownTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      const row = task(id);
      if (hasMcpSchema(db)) {
        validateReviewer('executorName' in body.data ? data.executorName : row.assignee_name, row.reviewer_name);
        if ('executorName' in body.data && data.executorName !== row.assignee_name) {
          withCoordinatedWrite(db, id, () => db.prepare('UPDATE tasks SET assignee_name=?,updated_at=? WHERE id=?')
            .run(data.executorName, new Date(now()).toISOString(), id));
          row.assignee_name = data.executorName;
        }
      }
      const old = db.prepare('SELECT revision FROM task_coordination WHERE task_id=?').get(id);
      if ((old?.revision || 0) !== body.revision) fail(409, 'Карточка изменена другим исполнителем. Обновите её перед сохранением');
      const revision = body.revision + 1, stamp = new Date(now()).toISOString(), json = JSON.stringify(data);
      db.prepare(`INSERT INTO task_coordination(task_id,revision,data,updated_at,updated_by) VALUES(?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .run(id,revision,json,stamp,actor.userId);
      db.prepare('INSERT INTO task_coordination_history VALUES(?,?,?,?,?)').run(id,revision,json,stamp,actor.userId);
      const result = entry(row);
      if (ownTransaction) db.exec('COMMIT'); return result;
    } catch (error) { if (ownTransaction) db.exec('ROLLBACK'); throw error; }
  };
  // Отдельная capability: не открывает обычный Owner API и не подменяет роль.
  const selfStatus = (id,body,actor,companyCode) => {
    const codes=actor?.companyCodes,permissions=actor?.permissions;
    if(!actor||!['owner','editor'].includes(actor.role)||!Number.isSafeInteger(actor.userId)||actor.userId<1||
      !(codes instanceof Set)||codes.size!==1||!codes.has(companyCode)||
      actor.role!=='owner'&&(!(permissions instanceof Set)||!permissions.has('tasks.self.edit')))fail(403,'Нет права изменять свою задачу');
    if(!object(body)||Object.keys(body).sort().join(',')!=='revision,status'||!Number.isSafeInteger(body.revision)||body.revision<0||
      !['inbox','planned','in_progress','done','cancelled'].includes(body.status))fail(400,'Передайте только статус и ревизию');
    if(!hasMcpSchema(db))fail(503,'Миграция задач MCP не установлена');
    const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try {
      const row=task(id);
      if(String(row.company_code).toLowerCase()!==companyCode||actor.role!=='owner'&&row.assignee_name!==`person:${actor.userId}`)fail(404,'Задача не найдена');
      const previous=db.prepare('SELECT revision,data FROM task_coordination WHERE task_id=?').get(id);
      if((previous?.revision||0)!==body.revision)fail(409,'Задача изменилась. Обновите карточку');
      if(body.status==='done')Steps.assertTaskCanFinish(db,row);
      // Статус не нормализует и не выбрасывает неизвестные прежние метаданные.
      const json=previous?.data||JSON.stringify({...empty(),executorName:row.assignee_name}),revision=body.revision+1,stamp=new Date(now()).toISOString();
      withCoordinatedWrite(db,id,()=>db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(body.status,stamp,id));
      db.prepare(`INSERT INTO task_coordination(task_id,revision,data,updated_at,updated_by) VALUES(?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(id,revision,json,stamp,actor.userId);
      db.prepare('INSERT INTO task_coordination_history(task_id,revision,data,updated_at,updated_by) VALUES(?,?,?,?,?)').run(id,revision,json,stamp,actor.userId);
      const result=entry({...row,status:body.status});
      if(own)db.exec('COMMIT');return result;
    }catch(error){if(own)db.exec('ROLLBACK');throw error;}
  };
  return {get,list,save,selfStatus,assertCanFinish:row=>Steps.assertTaskCanFinish(db,row),
    preserveSteps:(row,description)=>Steps.preserveBeforeDescriptionChange(db,row,description,new Date(now()).toISOString()),
    tool:createTaskTools(db,{now,owner,entry,save})};
}
module.exports = {createTaskCoordination,migrateTasksMcp,migrateTasksMcpPortable,
  ...require('./task-products')};

// Вызывается только новым migrate-блоком до запуска HTTP-сервера.
function migrateTasksMcp(db) {
  const objects = db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name='tasks'
    AND type IN ('index','trigger') AND sql IS NOT NULL`).all();
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='tasks'").get()?.seq || 0;
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
  const expanded = schema.replace(/CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)/i,
    (_, sources) => `CHECK(source IN (${sources}, 'claude', 'gpt'))`);
  if (schema === expanded) throw new Error('Не удалось расширить источники задач MCP');
  db.exec(expanded.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?tasks["`]?/i, 'CREATE TABLE tasks_mcp_v8'));
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map(row => `"${row.name}"`).join(',');
  db.exec(`INSERT INTO tasks_mcp_v8 (${columns}) SELECT ${columns} FROM tasks;
    DROP TABLE tasks; ALTER TABLE tasks_mcp_v8 RENAME TO tasks;
    ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id);
    ALTER TABLE tasks ADD COLUMN reviewer_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN client_ref TEXT;
    CREATE UNIQUE INDEX tasks_client_ref_uidx ON tasks(client_ref) WHERE client_ref IS NOT NULL;
    CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);`);
  db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='tasks'").run(sequence);
  for (const item of objects) db.exec(item.sql);
  db.exec(`
    CREATE TABLE task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id),
      author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX task_comments_task_idx ON task_comments(task_id,id);
    CREATE TABLE task_coordination_write_context(task_id INTEGER PRIMARY KEY REFERENCES tasks(id));
    CREATE TABLE task_assignment_migration (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id), previous_assignee_name TEXT NOT NULL,
      previous_executor_name TEXT NOT NULL, migrated_at TEXT NOT NULL);
    CREATE TRIGGER task_assignment_migration_no_update BEFORE UPDATE ON task_assignment_migration
      BEGIN SELECT RAISE(ABORT,'Immutable task assignment migration'); END;
    CREATE TRIGGER task_assignment_migration_no_delete BEFORE DELETE ON task_assignment_migration
      BEGIN SELECT RAISE(ABORT,'Immutable task assignment migration'); END;
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('owner','claude','codex','gpt','gemini','hailuo')),
      mode TEXT NOT NULL DEFAULT 'event' CHECK(mode IN ('permanent','periodic','event','once')),
      function TEXT NOT NULL DEFAULT '', chat TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK(state IN ('work','wait','idle','unknown','error')),
      last_event TEXT NOT NULL DEFAULT '', last_event_at TEXT NOT NULL);
    CREATE TABLE agent_access (
      agent_id INTEGER PRIMARY KEY REFERENCES agents(id), owner_id INTEGER NOT NULL, projects TEXT NOT NULL);
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id), owner_id INTEGER NOT NULL,
      request TEXT NOT NULL, projects TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
    CREATE UNIQUE INDEX agent_sessions_open_uidx ON agent_sessions(agent_id) WHERE ended_at IS NULL;
    CREATE TABLE agent_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id),
      agent_id INTEGER NOT NULL REFERENCES agents(id), summary TEXT NOT NULL,
      statuses TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TRIGGER task_comments_no_update BEFORE UPDATE ON task_comments
      BEGIN SELECT RAISE(ABORT,'Immutable task comments'); END;
    CREATE TRIGGER task_comments_no_delete BEFORE DELETE ON task_comments
      BEGIN SELECT RAISE(ABORT,'Immutable task comments'); END;
    CREATE TRIGGER agent_activity_no_update BEFORE UPDATE ON agent_activity
      BEGIN SELECT RAISE(ABORT,'Immutable agent activity'); END;
    CREATE TRIGGER agent_activity_no_delete BEFORE DELETE ON agent_activity
      BEGIN SELECT RAISE(ABORT,'Immutable agent activity'); END;
    CREATE TRIGGER tasks_parent_insert BEFORE INSERT ON tasks
      WHEN NEW.parent_task_id IS NOT NULL AND (NEW.parent_task_id=NEW.id OR NOT EXISTS (
        SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.is_deleted=0
          AND p.parent_task_id IS NULL AND lower(p.company_code)=lower(NEW.company_code)))
      BEGIN SELECT RAISE(ABORT,'TASK_PARENT_INVALID'); END;
    CREATE TRIGGER tasks_parent_update BEFORE UPDATE OF parent_task_id,company_code,is_deleted ON tasks
      WHEN (NEW.parent_task_id IS NOT NULL AND (NEW.parent_task_id=NEW.id OR NOT EXISTS (
        SELECT 1 FROM tasks p WHERE p.id=NEW.parent_task_id AND p.is_deleted=0
          AND p.parent_task_id IS NULL AND lower(p.company_code)=lower(NEW.company_code))))
        OR (EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id=NEW.id AND child.is_deleted=0)
          AND (NEW.parent_task_id IS NOT NULL OR NEW.is_deleted<>0 OR lower(NEW.company_code)<>lower(OLD.company_code)))
      BEGIN SELECT RAISE(ABORT,'TASK_PARENT_INVALID'); END;
  `);
  migrateTasksMcpPortable(db);
  // Старый CRUD и уже открытые формы участвуют в той же версии карточки.
  // updated_by=0 обозначает системную синхронизацию, а не личность владельца.
  createTaskCoordination(db);
  // Прежняя доска предпочитала executorName отдельному assignee_name. Сохраняем
  // видимое назначение, а оба старых значения — в неизменяемом снимке миграции.
  const assignments = db.prepare(`SELECT t.id,t.assignee_name,
      json_extract(c.data,'$.executorName') executor_name FROM tasks t
      JOIN task_coordination c ON c.task_id=t.id
    WHERE typeof(json_extract(c.data,'$.executorName'))='text'
      AND trim(json_extract(c.data,'$.executorName'))<>''
      AND json_extract(c.data,'$.executorName')<>t.assignee_name`).all();
  const migratedAt = new Date().toISOString();
  const archiveAssignment = db.prepare(`INSERT INTO task_assignment_migration
    (task_id,previous_assignee_name,previous_executor_name,migrated_at) VALUES(?,?,?,?)`);
  const preserveExecutor = db.prepare('UPDATE tasks SET assignee_name=? WHERE id=?');
  for (const assignment of assignments) {
    archiveAssignment.run(assignment.id,assignment.assignee_name,assignment.executor_name,migratedAt);
    preserveExecutor.run(assignment.executor_name,assignment.id);
  }
  const defaultData = JSON.stringify(empty()).replace(/'/g,"''");
  const syncedFields = ['title','description','status','assignee_name','reviewer_name','due_date',
    'priority','company_code','parent_task_id','is_deleted'];
  db.exec(`CREATE TRIGGER tasks_legacy_coordination_sync AFTER UPDATE OF ${syncedFields.join(',')} ON tasks
    WHEN NOT EXISTS (SELECT 1 FROM task_coordination_write_context WHERE task_id=NEW.id)
      AND (${syncedFields.map(field => `NEW.${field} IS NOT OLD.${field}`).join(' OR ')})
    BEGIN
      INSERT INTO task_coordination(task_id,revision,data,updated_at,updated_by)
        VALUES(NEW.id,
          coalesce((SELECT revision FROM task_coordination WHERE task_id=NEW.id),0)+1,
          json_set(coalesce((SELECT data FROM task_coordination WHERE task_id=NEW.id),'${defaultData}'),
            '$.executorName',NEW.assignee_name),NEW.updated_at,0)
        ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,
          updated_at=excluded.updated_at,updated_by=excluded.updated_by;
      INSERT INTO task_coordination_history(task_id,revision,data,updated_at,updated_by)
        SELECT task_id,revision,data,updated_at,updated_by FROM task_coordination WHERE task_id=NEW.id;
    END;`);
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Нарушена целостность миграции задач MCP');
}

// Только встроенные функции SQLite: правила работают в резервных копиях,
// скриптах и втором подключении, не загружавшем этот модуль JavaScript.
function asciiPersonKeySql(expression) {
  return `lower(trim(${expression},char(${PERSON_WHITESPACE.join(',')})))`;
}

function personKeySql(expression) {
  let result = asciiPersonKeySql(expression);
  for (const letter of PERSON_UPPERCASE_RU) {
    result = `replace(${result},'${letter}','${letter.toLowerCase()}')`;
  }
  return result;
}

// В постоянной схеме нельзя сохранять цепочку из 33 вложенных replace:
// SQLite 3.45 переполняет стек парсера уже при открытии такой базы.
// CTE разбивает ровно ту же нормализацию на короткие независимые выражения.
function portablePersonKeysSql(input) {
  const steps = [`person_key_0(kind,value) AS (${input})`];
  let index = 0;
  for (let offset = 0; offset < PERSON_UPPERCASE_RU.length; offset += 3) {
    let expression = 'value';
    for (const letter of PERSON_UPPERCASE_RU.slice(offset,offset+3)) {
      expression = `replace(${expression},'${letter}','${letter.toLowerCase()}')`;
    }
    steps.push(`person_key_${index+1}(kind,value) AS (SELECT kind,${expression} FROM person_key_${index})`);
    index++;
  }
  return {cte:`WITH ${steps.join(',\n')}`,table:`person_key_${index}`};
}

// Новая миграция 9: только наши индексы и триггеры. Строки, история,
// внешние ключи, последовательности и колонки остаются неизменными.
function migrateTasksMcpPortable(db) {
  const duplicateKeys = portablePersonKeysSql(`SELECT id,${asciiPersonKeySql('name')} FROM agents`);
  const duplicate = db.prepare(`${duplicateKeys.cte}
    SELECT 1 FROM ${duplicateKeys.table} GROUP BY value HAVING count(*)>1 LIMIT 1`).get();
  if (duplicate) throw new Error('Каталог агентов содержит совпадающие канонические имена');

  const reviewer = portablePersonKeysSql(`VALUES
    (0,${asciiPersonKeySql('NEW.reviewer_name')}),(1,${asciiPersonKeySql('NEW.assignee_name')})`);
  const reviewerConflict = `${reviewer.cte}
    SELECT 1 FROM ${reviewer.table} reviewer JOIN ${reviewer.table} executor ON reviewer.value=executor.value
      WHERE reviewer.kind=0 AND executor.kind=1 AND reviewer.value<>''`;
  const agentConflict = (insert) => {
    // Точное имя оставлено UNIQUE(name): это сохраняет INSERT ...
    // ON CONFLICT(name) DO UPDATE, которым агент сообщает новый статус.
    const existing = insert ? 'name<>NEW.name' : 'id<>OLD.id';
    const keys = portablePersonKeysSql(`SELECT 1,${asciiPersonKeySql('NEW.name')}
      UNION ALL SELECT 0,${asciiPersonKeySql('name')} FROM agents WHERE ${existing}`);
    return `${keys.cte}
      SELECT 1 FROM ${keys.table} candidate JOIN ${keys.table} saved ON candidate.value=saved.value
        WHERE candidate.kind=1 AND saved.kind=0`;
  };
  db.exec(`
    DROP INDEX IF EXISTS agents_name_key_uidx;
    DROP TRIGGER IF EXISTS tasks_reviewer_insert;
    DROP TRIGGER IF EXISTS tasks_reviewer_update;
    DROP TRIGGER IF EXISTS agents_name_key_insert;
    DROP TRIGGER IF EXISTS agents_name_key_update;
    CREATE UNIQUE INDEX agents_name_key_uidx ON agents(${asciiPersonKeySql('name')});
    CREATE TRIGGER tasks_reviewer_insert BEFORE INSERT ON tasks
      WHEN EXISTS (${reviewerConflict})
      BEGIN SELECT RAISE(ABORT,'TASK_REVIEWER_EQUALS_EXECUTOR'); END;
    CREATE TRIGGER tasks_reviewer_update BEFORE UPDATE OF reviewer_name,assignee_name ON tasks
      WHEN EXISTS (${reviewerConflict})
      BEGIN SELECT RAISE(ABORT,'TASK_REVIEWER_EQUALS_EXECUTOR'); END;
    CREATE TRIGGER agents_name_key_insert BEFORE INSERT ON agents
      WHEN EXISTS (${agentConflict(true)})
      BEGIN SELECT RAISE(ABORT,'UNIQUE constraint failed: agents.name_key'); END;
    CREATE TRIGGER agents_name_key_update BEFORE UPDATE OF name ON agents
      WHEN EXISTS (${agentConflict(false)})
      BEGIN SELECT RAISE(ABORT,'UNIQUE constraint failed: agents.name_key'); END;
  `);
}

function withCoordinatedWrite(db, taskId, callback) {
  if (!db.isTransaction) throw new Error('Синхронизация задачи требует транзакцию');
  const inserted = db.prepare('INSERT OR IGNORE INTO task_coordination_write_context(task_id) VALUES(?)').run(taskId).changes;
  try { return callback(); }
  finally { if (inserted) db.prepare('DELETE FROM task_coordination_write_context WHERE task_id=?').run(taskId); }
}

function hasMcpSchema(db) {
  return db.prepare('PRAGMA table_info(tasks)').all().some(row => row.name === 'reviewer_name');
}

function validateReviewer(executor, reviewer) {
  if (reviewer && String(executor).trim().toLocaleLowerCase('ru') === String(reviewer).trim().toLocaleLowerCase('ru')) {
    fail(400, 'Исполнитель и проверяющий должны быть разными');
  }
}

function validateLinks(value) {
  if (!Array.isArray(value) || value.length > 50) fail(400, 'Нужен список не более 50 ссылок');
  const seen = new Set();
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['url','label','kind'].includes(key))) fail(400, 'Некорректная ссылка');
    const url = text(item.url, 2048), label = text(item.label || '', 200), kind = item.kind || 'link';
    let parsed;
    try { parsed = new URL(url); } catch { fail(400, 'Некорректный адрес ссылки'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['link','image','video'].includes(kind)) fail(400, 'Нужна HTTPS-ссылка без учётных данных');
    if (seen.has(url)) fail(400, 'Ссылки не должны повторяться');
    seen.add(url);
    return {url,label,kind};
  });
}

// Блок «Точка А → Точка Б»: сохранённый в coordination или разобранный из старого описания.
function pointABView(row, coordination) {
  const value = Steps.effective(coordination?.pointAB, row.description);
  const steps = Steps.counts(value);
  return {point_ab:value, acceptance_steps:steps,
    progress:Steps.progress(row.status, coordination?.milestones, steps)};
}

function taskExtras(db, row, now) {
  const counts = db.prepare(`SELECT count(*) total,coalesce(sum(status='done'),0) done
    FROM tasks WHERE parent_task_id=? AND is_deleted=0`).get(row.id);
  const coord = db.prepare('SELECT updated_at,data FROM task_coordination WHERE task_id=?').get(row.id);
  const assignment = row.assignee_name || (coord ? JSON.parse(coord.data).executorName : '');
  const agent = db.prepare(`SELECT state FROM agents WHERE ${personKeySql('name')}=${personKeySql('?')}`).get(assignment);
  const updated = Math.max(Date.parse(row.updated_at) || 0, Date.parse(coord?.updated_at) || 0);
  return {reviewer_name:row.reviewer_name, parent_task_id:row.parent_task_id, source:row.source,
    due_date:row.due_date, subtask_count:counts.total, subtask_done:counts.done,
    ...boardFields(db,row),
    no_report:agent?.state === 'work' && ['inbox','planned','in_progress'].includes(row.status) && now-updated > 60*60*1000};
}

function createTaskTools(db, {now,owner,entry,save}) {
  // Архив устанавливается отдельно с резервной копией; чтение старых задач не запускает DDL.
  const archive = require('./module-archive').createModuleArchive(db, {now});
  const stamp = () => new Date(now()).toISOString();
  const integer = (value, label='задача') => {
    if (!Number.isSafeInteger(value) || value < 1) fail(400, `Некорректное поле: ${label}`);
    return value;
  };
  const allowed = actor => new Set(['','synapse','synapse-business',
    ...((actor.companyCodes instanceof Set || Array.isArray(actor.companyCodes)) ? [...actor.companyCodes] : [])]
    .map(value => String(value).trim().toLowerCase()));
  const project = (value, actor) => {
    const code = text(value, 64).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) || !allowed(actor).has(code)) fail(404, 'Проект не найден');
    if (!['synapse','synapse-business'].includes(code) &&
        !db.prepare('SELECT 1 FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code)) {
      fail(404, 'Проект не найден');
    }
    return code;
  };
  const scopedTask = (id, actor) => {
    integer(id);
    const row = db.prepare('SELECT * FROM tasks WHERE id=? AND is_deleted=0').get(id);
    if (!row || !allowed(actor).has(row.company_code.toLowerCase())) fail(404, 'Задача не найдена');
    return row;
  };
  const transaction = callback => {
    const own = !db.isTransaction;
    if (own) db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); if (own) db.exec('COMMIT'); return result; }
    catch (error) { if (own) db.exec('ROLLBACK'); throw error; }
  };
  const page = (args, prefix, max) => {
    const limit=args[`${prefix}_limit`] ?? 20, offset=args[`${prefix}_offset`] ?? 0;
    if (!Number.isSafeInteger(limit) || limit<1 || limit>max || !Number.isSafeInteger(offset) || offset<0) {
      fail(400,'Некорректная страница задачи');
    }
    return {limit,offset};
  };
  const taskSummary = (row,overview=false) => {
    const fields=['id','title','company_code','assignee_name','reviewer_name','parent_task_id',
      'status','priority','due_date','source','updated_at'];
    const coordination=entry(row);
    let description='',descriptionTruncated=false;
    if(overview===true) {
      let count=0;
      for(const character of row.description || '') {
        if(count===1000){descriptionTruncated=true;break;}
        description+=character;count++;
      }
    }
    const ab=pointABView(row,coordination);
    return {...Object.fromEntries(fields.map(key=>[key,row[key]])),
      ...boardFields(db,row),acceptance_steps:ab.acceptance_steps,progress:ab.progress,
      subtask_count:coordination.subtask_count,subtask_done:coordination.subtask_done,no_report:coordination.no_report,
      ...(overview===true?{description,description_truncated:descriptionTruncated,
        created_at:row.created_at,waiting_since:waitingSince(db,row,coordination,now())}:{}),
      coordination:{revision:coordination.revision,executorName:row.assignee_name,
        ...(overview===true?{blocker:coordination.blocker,nextAction:coordination.nextAction,updatedAt:coordination.updatedAt}:{}),
        milestones:Object.fromEntries(STAGES.map(stage=>[stage,{state:coordination.milestones[stage].state}]))}};
  };
  const taskView = (row, actor, detail=false, args={}) => {
    const fields = ['id','created_at','updated_at','title','description','company_code','assignee_name',
      'status','priority','due_date','source','parent_task_id','reviewer_name','client_ref'];
    const coordination=entry(row);
    const result = {...Object.fromEntries(fields.map(key => [key,row[key]])), ...taskExtras(db,row,now()), coordination,
      waiting_since:waitingSince(db,row,coordination,now()), ...pointABView(row,coordination)};
    if (detail) {
      const comments=page(args,'comments',20), subtasks=page(args,'subtasks',100);
      const codes=[...allowed(actor)], childWhere=`parent_task_id=? AND is_deleted=0
        AND lower(company_code) IN (${codes.map(()=>'?').join(',')})`;
      result.subtasks = db.prepare(`SELECT * FROM tasks WHERE ${childWhere} ORDER BY id LIMIT ? OFFSET ?`)
        .all(row.id,...codes,subtasks.limit,subtasks.offset).map(taskSummary);
      result.subtasks_pagination={total:db.prepare(`SELECT count(*) n FROM tasks WHERE ${childWhere}`).get(row.id,...codes).n,...subtasks};
      result.comments = db.prepare(`SELECT id,task_id,author,text,created_at FROM task_comments WHERE task_id=?
        ORDER BY id DESC LIMIT ? OFFSET ?`).all(row.id,comments.limit,comments.offset);
      result.comments_pagination={total:db.prepare('SELECT count(*) n FROM task_comments WHERE task_id=?').get(row.id).n,...comments};
    }
    return result;
  };
  const statuses = ['inbox','planned','in_progress','done','cancelled'];
  const products=createTaskProducts(db,{project,scopedTask,allowed,taskSummary});
  const enumValue = (value, values, label) => { if (!values.includes(value)) fail(400, `Некорректное поле: ${label}`); return value; };
  const dueDate = value => {
    const result = text(value,10);
    if (result && (!/^\d{4}-\d\d-\d\d$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) ||
        new Date(`${result}T00:00:00Z`).toISOString().slice(0,10)!==result)) {
      fail(400, 'Нужна дата YYYY-MM-DD');
    }
    return result;
  };
  const touch = (row, changes, actor) => {
    const previous = entry(row);
    const data = Object.fromEntries([...TEXT_FIELDS,'modelCheckedAt','milestones','links'].map(key => [key,previous[key] ?? empty()[key]]));
    Object.assign(data,changes);
    save(row.id,{revision:previous.revision,data},actor);
  };
  const update = (args, actor) => transaction(() => {
    const row = scopedTask(args.task_id,actor);
    const previous = entry(row);
    if (args.revision !== undefined && args.revision !== previous.revision) fail(409, 'Задача изменена. Обновите карточку');
    const updates = {}, changes = {};
    if ('status' in args) updates.status = enumValue(args.status,statuses,'status');
    if (updates.status === 'done') Steps.assertTaskCanFinish(db,row);
    if ('executor' in args) { updates.assignee_name = text(args.executor,200); changes.executorName=updates.assignee_name; }
    if ('reviewer' in args) updates.reviewer_name = text(args.reviewer,200);
    if ('due_date' in args) updates.due_date = dueDate(args.due_date);
    if ('priority' in args) updates.priority=enumValue(args.priority,['low','normal','high','urgent'],'priority');
    if ('parent_id' in args) updates.parent_task_id=products.validateParent(args.parent_id===null?null:integer(args.parent_id,'parent_id'),row,actor);
    if ('product_id' in args) {
      if(!hasBoardSchema(db))fail(503,'Миграция продуктов доски не установлена');
      updates.product_id=args.product_id===null?null:products.product(args.product_id,row.company_code.toLowerCase(),actor).id;
    }
    if ('chat_url' in args) {
      if (!hasBoardSchema(db)) fail(503,'Миграция доски не установлена');
      updates.chat_url=validatedChat(args.chat_url);
    }
    validateReviewer(updates.assignee_name ?? row.assignee_name, updates.reviewer_name ?? row.reviewer_name);
    if ('blocker' in args) changes.blocker=text(args.blocker,4000);
    if ('next_step' in args) changes.nextAction=text(args.next_step,4000);
    if ('links' in args) changes.links=validateLinks(args.links);
    if ('stage' in args) {
      const stage=enumValue(args.stage,STAGES,'stage'), evidence=text(args.evidence || '',4000), checkedAt=date(args.checked_at);
      if (!evidence || Date.parse(checkedAt)>now()) fail(400, 'Для этапа нужны основание и дата выполненной проверки');
      changes.milestones={...previous.milestones,[stage]:{state:'confirmed',evidence,checkedAt}};
    }
    if (!Object.keys(updates).length && !Object.keys(changes).length) fail(400, 'Нет изменений задачи');
    if (Object.keys(updates).length) withCoordinatedWrite(db, row.id, () =>
      db.prepare(`UPDATE tasks SET ${Object.keys(updates).map(key=>`${key}=?`).join(',')},updated_at=? WHERE id=?`)
        .run(...Object.values(updates),stamp(),row.id));
    touch({...row,...updates},changes,actor);
    return {task:taskView(scopedTask(row.id,actor),actor,true)};
  });
  const tasksList = (args, actor) => {
    if(args.overview!==undefined&&typeof args.overview!=='boolean')fail(400,'overview должен быть логическим');
    const limit=args.limit===undefined?100:integer(args.limit,'limit'), offset=args.offset===undefined?0:args.offset;
    if (limit>100 || !Number.isSafeInteger(offset) || offset<0) fail(400, 'Некорректная страница');
    const codes=args.project!==undefined?[project(args.project,actor)]:[...allowed(actor)];
    const clauses=[`is_deleted=0`,`lower(company_code) IN (${codes.map(()=>'?').join(',')})`], params=[...codes];
    if (args.status!==undefined) { clauses.push('status=?'); params.push(enumValue(args.status,statuses,'status')); }
    if (args.product!==undefined) {
      if(!hasBoardSchema(db))fail(503,'Миграция продуктов доски не установлена');
      if(args.product===null)clauses.push('product_id IS NULL');
      else { products.product(args.product,args.project!==undefined?codes[0]:null,actor);clauses.push('product_id=?');params.push(args.product); }
    }
    if (args.executor!==undefined) { clauses.push(`${personKeySql('assignee_name')}=${personKeySql('?')}`); params.push(text(args.executor,200)); }
    if (args.parent_id!==undefined) {
      if (args.parent_id===null) clauses.push('parent_task_id IS NULL');
      else { scopedTask(integer(args.parent_id),actor); clauses.push('parent_task_id=?');params.push(args.parent_id); }
    }
    if (args.today!==undefined && typeof args.today!=='boolean') fail(400, 'today должен быть логическим');
    if (args.today) {
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(now());
      clauses.push("due_date<>'' AND due_date<=? AND status NOT IN ('done','cancelled')");params.push(today);
    }
    if (args.search!==undefined) { const search=text(args.search,500);clauses.push('(title LIKE ? OR description LIKE ?)');params.push(`%${search}%`,`%${search}%`); }
    const where=clauses.join(' AND '), total=db.prepare(`SELECT count(*) n FROM tasks WHERE ${where}`).get(...params).n;
    const tasks=db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset).map(row=>taskSummary(row,args.overview===true));
    return {tasks,pagination:{total,limit,offset}};
  };
  const agentView = (row, actor) => {
    const codes=[...allowed(actor)];
    const activeWhere=`t.is_deleted=0 AND t.status NOT IN ('done','cancelled')
      AND ${personKeySql('t.assignee_name')}=${personKeySql('?')} AND lower(t.company_code) IN (${codes.map(()=>'?').join(',')})`;
    const taskTimes=db.prepare(`SELECT t.updated_at,c.updated_at coordination_updated_at FROM tasks t
      LEFT JOIN task_coordination c ON c.task_id=t.id WHERE ${activeWhere}`).all(row.name,...codes);
    const tasks=db.prepare(`SELECT t.* FROM tasks t WHERE ${activeWhere} ORDER BY t.id DESC LIMIT 100`)
      .all(row.name,...codes).map(taskSummary);
    const access=db.prepare('SELECT * FROM agent_access WHERE agent_id=?').get(row.id);
    const sameScope=access?.owner_id===actor.userId && access.projects===JSON.stringify([...allowed(actor)].sort());
    return {...row,...(!sameScope?{state:'unknown',last_event:'',last_event_at:'',function:'',chat:'',...(hasBoardSchema(db)?{chat_url:''}:{})}:{}),tracking:'manual',
      active_tasks:tasks,active_task_count:taskTimes.length,
      no_report:sameScope&&row.state==='work'&&taskTimes.some(task=>now()-Math.max(Date.parse(task.updated_at)||0,Date.parse(task.coordination_updated_at)||0)>60*60*1000)};
  };
  const reportAgent = (args, actor) => {
    const name=text(args.agent,200);
    if (!name) fail(400,'Укажите имя агента');
    const old=db.prepare(`SELECT * FROM agents WHERE ${personKeySql('name')}=${personKeySql('?')}`).get(name);
    if (old) {
      const access=db.prepare('SELECT * FROM agent_access WHERE agent_id=?').get(old.id);
      if (access && (access.owner_id!==actor.userId || access.projects!==JSON.stringify([...allowed(actor)].sort()))) fail(404,'Агент не найден в области подключения');
    }
    const kind=enumValue(args.kind ?? old?.kind,['owner','claude','codex','gpt','gemini','hailuo'],'kind');
    const mode=enumValue(args.mode ?? old?.mode ?? 'event',['permanent','periodic','event','once'],'mode');
    const state=enumValue(args.state ?? old?.state ?? 'unknown',['work','wait','idle','unknown','error'],'state');
    const event=text(args.last_event ?? old?.last_event ?? '',4000), role=text(args.function ?? old?.function ?? '',500),
      chat='chat_url' in args?validatedChat(args.chat_url):text(args.chat ?? old?.chat ?? '',2048);
    db.prepare(`INSERT INTO agents(name,kind,mode,function,chat,state,last_event,last_event_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET kind=excluded.kind,mode=excluded.mode,function=excluded.function,chat=excluded.chat,
      state=excluded.state,last_event=excluded.last_event,last_event_at=excluded.last_event_at`).run(old?.name || name,kind,mode,role,chat,state,event,stamp());
    const row=db.prepare(`SELECT * FROM agents WHERE ${personKeySql('name')}=${personKeySql('?')}`).get(name);
    if(hasBoardSchema(db)) {
      let chatUrl=old?.chat_url || '';
      if('chat_url' in args)chatUrl=validatedChat(args.chat_url);
      else if('chat' in args) { try { chatUrl=validatedChat(args.chat); } catch { chatUrl=''; } }
      db.prepare('UPDATE agents SET chat_url=? WHERE id=?').run(chatUrl,row.id);
      row.chat_url=chatUrl;
    }
    db.prepare(`INSERT INTO agent_access(agent_id,owner_id,projects) VALUES(?,?,?) ON CONFLICT(agent_id)
      DO UPDATE SET owner_id=excluded.owner_id,projects=excluded.projects`).run(row.id,actor.userId,JSON.stringify([...allowed(actor)].sort()));
    return agentView(row,actor);
  };
  // Отдельная запись блока А/Б: ревизия и неизменяемая история те же, что у карточки.
  const pointAB = (name, args, actor) => {
    const allowedKeys = {task_point_ab:['task_id','revision','point_ab'],
      task_step_close:['task_id','revision','step_id','evidence','kind','author'],
      task_step_reopen:['task_id','revision','step_id'],
      task_step_remove:['task_id','revision','step_id','reason','author']}[name];
    if (Object.keys(args).some(key => !allowedKeys.includes(key))) fail(400,'Неизвестный параметр шага приёмки');
    const row = scopedTask(args.task_id,actor);
    const saved = db.prepare('SELECT revision,data FROM task_coordination WHERE task_id=?').get(row.id);
    if (args.revision !== undefined && args.revision !== (saved?.revision || 0)) fail(409,'Задача изменена. Обновите карточку');
    const data = saved ? JSON.parse(saved.data) : {...empty(),executorName:row.assignee_name};
    const current = Steps.effective(data.pointAB,row.description);
    let next;
    if (name === 'task_point_ab') next = Steps.merge(current,Steps.validateIncoming(args.point_ab));
    else {
      if (!current) fail(404,'Шаг приёмки не найден');
      const author = args.author === undefined || name === 'task_step_reopen' ? '' : text(args.author,200);
      if (name === 'task_step_remove') next = Steps.remove(current,{id:args.step_id,reason:args.reason},
        {...actor,author},row.assignee_name,stamp());
      else if (name === 'task_step_close') next = Steps.close(current,{id:args.step_id,evidence:args.evidence,
        ...(args.kind === undefined ? {} : {kind:args.kind})},{...actor,author},row.assignee_name,stamp());
      else next = Steps.reopen(current,{id:args.step_id});
    }
    data.pointAB = Steps.stored(next);
    const revision = (saved?.revision || 0) + 1, time = stamp(), json = JSON.stringify(data);
    db.prepare(`INSERT INTO task_coordination(task_id,revision,data,updated_at,updated_by) VALUES(?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(row.id,revision,json,time,actor.userId);
    db.prepare('INSERT INTO task_coordination_history(task_id,revision,data,updated_at,updated_by) VALUES(?,?,?,?,?)').run(row.id,revision,json,time,actor.userId);
    return {task:taskView(scopedTask(row.id,actor),actor,true)};
  };
  return (name,args,actor) => {
    owner(actor);
    if (!object(args)) fail(400,'Нужен объект параметров');
    if (!hasMcpSchema(db)) fail(503,'Миграция задач MCP не установлена');
    if (name.startsWith('archive_')) return archive.tool(name,args,actor);
    if (name==='tasks_list') return tasksList(args,actor);
    if (name==='products_list') return products.list(args,actor);
    if (name==='task_duplicates') return products.duplicates(args,actor);
    if (name==='task_get') return taskView(scopedTask(args.task_id,actor),actor,true,args);
    if (name==='task_update') return update(args,actor);
    if (name==='task_create') return transaction(()=>{
      const code=project(args.project,actor), clientRef=text(args.client_ref,200);
      if (!clientRef) fail(400,'Укажите client_ref для защиты от повторов');
      const existing=db.prepare('SELECT * FROM tasks WHERE client_ref=?').get(clientRef);
      if (existing) {
        if (existing.is_deleted || existing.company_code.toLowerCase()!==code) fail(404,'Задача не найдена');
        return {task:taskView(scopedTask(existing.id,actor),actor,true),created:false};
      }
      const title=text(args.title,1000); if(!title)fail(400,'Укажите название задачи');
      if(args.force!==undefined&&typeof args.force!=='boolean')fail(400,'force должен быть логическим');
      const executor=text(args.executor || '',200), reviewer=text(args.reviewer || '',200);validateReviewer(executor,reviewer);
      const parent=args.parent_id==null?null:integer(args.parent_id,'parent_id');
      if(parent!==null) {
        const row=scopedTask(parent,actor);
        if(row.parent_task_id!==null||row.company_code.toLowerCase()!==code) {
          fail(400,'Подзадача должна принадлежать корневой задаче того же проекта');
        }
      }
      const description=text(args.description || '',20000), priority=enumValue(args.priority || 'normal',['low','normal','high','urgent'],'priority'),
        due=dueDate(args.due_date || ''),source=enumValue(args.source || 'manual',['claude','gpt','manual'],'source'),
        status=enumValue(args.status || 'inbox',statuses,'status'),links=validateLinks(args.links || []),chatUrl=validatedChat(args.chat_url || '');
      let productId=null;
      if(hasBoardSchema(db)) {
        const duplicates=products.duplicates(args,actor);
        if(!args.force&&(duplicates.possible_duplicates.length||duplicates.possible_product_duplicates.length))return {created:false,...duplicates};
        productId=products.resolve(args,code,actor);
      } else if(args.product_id!=null||args.new_product!==undefined||args.chat_url!==undefined)fail(503,'Миграция продуктов доски не установлена');
      const time=stamp();
      const result=db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code,assignee_name,reviewer_name,
        priority,due_date,source,created_by,parent_task_id,client_ref,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(time,time,title,
        description,code,executor,reviewer,priority,due,source,String(actor.userId),parent,clientRef,status);
      const row=scopedTask(Number(result.lastInsertRowid),actor);
      if(hasBoardSchema(db)) {
        db.prepare('UPDATE tasks SET product_id=?,chat_url=? WHERE id=?').run(productId,chatUrl,row.id);
        row.product_id=productId;row.chat_url=chatUrl;
      }
      touch(row,{executorName:executor,links},actor);
      // Новая задача сразу в «Готово» проходит ту же проверку шагов, что и смена статуса.
      if(status==='done')Steps.assertTaskCanFinish(db,{...row,status:'inbox'});
      return {task:taskView(row,actor,true),created:true};
    });
    if(name==='task_comment')return transaction(()=>{
      const row=scopedTask(args.task_id,actor), author=text(args.author || args.agent || '',200), message=text(args.text,20000);
      if(!author||!message)fail(400,'Укажите автора и текст комментария');
      const result=db.prepare('INSERT INTO task_comments(task_id,author,text,created_at) VALUES(?,?,?,?)').run(row.id,author,message,stamp());
      db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(stamp(),row.id);
      return {comment:db.prepare('SELECT * FROM task_comments WHERE id=?').get(Number(result.lastInsertRowid))};
    });
    if(['task_point_ab','task_step_close','task_step_reopen','task_step_remove'].includes(name))return transaction(()=>pointAB(name,args,actor));
    if(name==='agents_list')return {agents:db.prepare('SELECT * FROM agents ORDER BY id').all().map(row=>agentView(row,actor))};
    if(name==='agent_report')return transaction(()=>({agent:reportAgent(args,actor)}));
    if(name==='session_start')return transaction(()=>{
      const request=text(args.request,4000), agent=reportAgent({...args,state:'work',last_event:'подключился'},actor);
      const existing=db.prepare('SELECT * FROM agent_sessions WHERE agent_id=? AND ended_at IS NULL').get(agent.id);
      const projects=JSON.stringify([...allowed(actor)].sort());
      if(existing) {
        if(existing.owner_id!==actor.userId||existing.projects!==projects)fail(404,'Сессия не найдена');
        return {session_id:existing.id,agent,tasks:agent.active_tasks,resumed:true,archives:archive.hints(request,actor)};
      }
      const sessionId=require('node:crypto').randomUUID();
      db.prepare('INSERT INTO agent_sessions(id,agent_id,owner_id,request,projects,started_at) VALUES(?,?,?,?,?,?)')
        .run(sessionId,agent.id,actor.userId,request,projects,stamp());
      return {session_id:sessionId,agent,tasks:agent.active_tasks,resumed:false,archives:archive.hints(request,actor)};
    });
    if(name==='session_end')return transaction(()=>{
      const session=db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(text(args.session_id,100));
      if(!session||session.owner_id!==actor.userId||JSON.stringify([...allowed(actor)].sort())!==session.projects)fail(404,'Сессия не найдена');
      const old=db.prepare('SELECT * FROM agents WHERE id=?').get(session.agent_id);
      const summary=text(args.summary,10000);if(!summary)fail(400,'Укажите итог работы');
      const changes=args.statuses || [];
      if(!Array.isArray(changes)||changes.length>100)fail(400,'Некорректный список статусов');
      if(session.ended_at){return {session_id:session.id,agent:agentView(old,actor),activity:db.prepare('SELECT * FROM agent_activity WHERE session_id=?').get(session.id)};}
      for(const change of changes){if(!object(change))fail(400,'Некорректный статус');const task=scopedTask(change.task_id,actor);
        if(task.assignee_name.toLocaleLowerCase('ru')!==old.name.toLocaleLowerCase('ru'))fail(400,'Сессия может менять статусы только своих задач');update(change,actor);}
      const agent=reportAgent({agent:old.name,state:args.state || 'idle',last_event:summary},actor);
      db.prepare('UPDATE agent_sessions SET ended_at=? WHERE id=?').run(stamp(),session.id);
      db.prepare('INSERT INTO agent_activity(session_id,agent_id,summary,statuses,created_at) VALUES(?,?,?,?,?)').run(session.id,old.id,summary,JSON.stringify(changes),stamp());
      return {session_id:session.id,agent,activity:db.prepare('SELECT * FROM agent_activity WHERE session_id=?').get(session.id)};
    });
    fail(404,'Инструмент не найден');
  };
}
