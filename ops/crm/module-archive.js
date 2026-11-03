'use strict';

const {createHash} = require('node:crypto');
const VERSION = 'module-archive-v1';
const TYPES = ['tried', 'succeeded', 'failed', 'report', 'decision', 'next_step'];
const DAY = 24 * 60 * 60 * 1000;
const KEYS = {
  archive_list: ['module', 'project', 'session_id', 'limit', 'offset'],
  archive_read: ['id', 'session_id'],
  archive_write: ['session_id', 'client_ref', 'module', 'project', 'type', 'text', 'links', 'task_id', 'supersedes_id']
};
const KEYWORDS = {
  sites: ['сайт', 'sites', 'website', 'вёрстк', 'верстк'],
  'content-factory': ['контент', 'соцсет', 'публикац', 'автопост', 'content', 'social'],
  analytics: ['аналитик', 'analytics', 'сквозн', 'метрик'],
  advertising: ['реклам', 'директ', 'advertising', 'кампани', 'ads'],
  maps: ['карт', '2гис', '2gis', 'maps'],
  crm: ['crm', 'заявк', 'сделк', 'клиент'],
  'chat-hugh': ['чат', 'хью', 'hugh', 'chat']
};
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, max, {empty = false} = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    fail(400, 'Некорректное текстовое поле архива');
  }
  return value.trim();
}
function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Некорректный идентификатор архива');
  return value;
}
function code(value) {
  const result = text(value, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) fail(400, 'Некорректный код архива или проекта');
  return result;
}
function links(value = []) {
  if (!Array.isArray(value) || value.length > 50) fail(400, 'Нужно не более 50 ссылок архива');
  const seen = new Set();
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['url', 'label', 'kind'].includes(key))) {
      fail(400, 'Некорректная ссылка архива');
    }
    const url = text(item.url, 2000), label = text(item.label ?? '', 200, {empty: true});
    const kind = item.kind ?? 'link';
    let parsed;
    try { parsed = new URL(url); } catch { fail(400, 'Некорректный адрес ссылки архива'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !['link', 'image', 'video', 'file'].includes(kind) || seen.has(url)) {
      fail(400, 'Нужны разные HTTPS-ссылки без учётных данных');
    }
    seen.add(url);
    return {url, label, kind};
  });
}

function createModuleArchive(db, {now = () => Date.now()} = {}) {
  const stamp = () => new Date(now()).toISOString();
  const installed = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='module_archive_migrations'").get() &&
    db.prepare('SELECT 1 FROM module_archive_migrations WHERE version=?').get(VERSION));
  const owner = actor => {
    if (actor?.role !== 'owner' || !Number.isSafeInteger(actor.userId) || actor.userId < 1 ||
        !(actor.companyCodes instanceof Set || Array.isArray(actor.companyCodes))) {
      fail(403, 'Архив доступен владельцу в области подключения');
    }
  };
  const scope = actor => [...new Set([...actor.companyCodes].map(value => {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.trim())) {
      fail(403, 'Некорректная область подключения');
    }
    return value.trim().toLowerCase();
  }))].sort();
  const activeProject = value => value === 'synapse-business' || Boolean(db.prepare(
    'SELECT 1 FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(value));
  const project = (value, actor) => {
    const result = code(value);
    if (!scope(actor).includes(result) || !activeProject(result)) fail(404, 'Проект архива не найден');
    return result;
  };
  const moduleRow = value => {
    const row = db.prepare('SELECT * FROM module_archive_modules WHERE code=?').get(code(value));
    if (!row) fail(404, 'Модуль архива не найден');
    return row;
  };
  const card = row => ({code: row.code, name: row.name, purpose: row.purpose,
    final_product: row.final_product, responsible: row.responsible, data_sources: JSON.parse(row.data_sources)});
  const transaction = callback => {
    const own = !db.isTransaction;
    if (own) db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); if (own) db.exec('COMMIT'); return result; }
    catch (error) { if (own) db.exec('ROLLBACK'); throw error; }
  };
  const session = (value, actor, required = false) => {
    if (value === undefined && !required) return null;
    const id = text(value, 200);
    const row = db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(id);
    // Прежний session_start хранит эти три системных проекта даже при узком подключении.
    // Это сравнение совместимости сессии; область самого архива остаётся строго явной.
    const expected = JSON.stringify([...new Set(['', 'synapse', 'synapse-business', ...scope(actor)])].sort());
    if (!row || row.owner_id !== actor.userId || row.projects !== expected || row.ended_at !== null) {
      fail(404, 'Открытая сессия архива не найдена');
    }
    return row;
  };
  const audit = (operation, module, projectCode, entryId, currentSession, actor) => db.prepare(`
    INSERT INTO module_archive_access(operation,module_code,project_code,entry_id,session_id,agent_id,owner_id,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(operation, module, projectCode, entryId,
    currentSession?.id ?? null, currentSession?.agent_id ?? null, actor.userId, stamp());
  const entryView = row => {
    const agent = db.prepare('SELECT id,name,kind FROM agents WHERE id=?').get(row.agent_id);
    return {id: row.id, module: row.module_code, project: row.project_code, type: row.entry_type,
      text: row.text, links: JSON.parse(row.links_json), task_id: row.task_id, supersedes_id: row.supersedes_id,
      agent: {...agent}, owner_id: row.owner_id, created_at: row.created_at};
  };
  const scopedEntry = (id, actor) => {
    const row = db.prepare('SELECT * FROM module_archive_entries WHERE id=?').get(positive(id));
    if (!row || !scope(actor).includes(row.project_code) || !activeProject(row.project_code)) {
      fail(404, 'Запись архива не найдена');
    }
    return row;
  };
  const write = (args, actor) => transaction(() => {
    const currentSession = session(args.session_id, actor, true);
    const module = moduleRow(args.module).code, projectCode = project(args.project, actor);
    if (!TYPES.includes(args.type)) fail(400, 'Некорректный тип записи архива');
    const content = text(args.text, 10000), attachments = links(args.links);
    const clientRef = text(args.client_ref, 200);
    const taskId = args.task_id == null ? null : positive(args.task_id);
    const supersedesId = args.supersedes_id == null ? null : positive(args.supersedes_id);
    const requestHash = createHash('sha256').update(JSON.stringify({module, project: projectCode,
      type: args.type, text: content, links: attachments, task_id: taskId, supersedes_id: supersedesId})).digest('hex');
    const existing = db.prepare('SELECT * FROM module_archive_entries WHERE owner_id=? AND client_ref=?').get(actor.userId, clientRef);
    if (existing) {
      if (!scope(actor).includes(existing.project_code) || !activeProject(existing.project_code)) fail(404, 'Запись архива не найдена');
      if (existing.request_hash !== requestHash) fail(409, 'Этот ключ уже использован для другой записи архива');
      audit('write', existing.module_code, existing.project_code, existing.id, currentSession, actor);
      return {entry: entryView(existing), created: false};
    }
    if (taskId !== null) {
      const task = db.prepare('SELECT company_code FROM tasks WHERE id=? AND is_deleted=0').get(taskId);
      if (!task || task.company_code.toLowerCase() !== projectCode) fail(404, 'Связанная задача не найдена в проекте архива');
    }
    if (supersedesId !== null) {
      const previous = scopedEntry(supersedesId, actor);
      if (previous.module_code !== module || previous.project_code !== projectCode) fail(404, 'Исправляемая запись не найдена в архиве проекта');
    }
    const result = db.prepare(`INSERT INTO module_archive_entries(module_code,project_code,entry_type,text,links_json,
      task_id,supersedes_id,session_id,agent_id,owner_id,client_ref,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(module, projectCode, args.type, content, JSON.stringify(attachments), taskId, supersedesId,
        currentSession.id, currentSession.agent_id, actor.userId, clientRef, requestHash, stamp());
    const row = db.prepare('SELECT * FROM module_archive_entries WHERE id=?').get(Number(result.lastInsertRowid));
    audit('write', module, projectCode, row.id, currentSession, actor);
    return {entry: entryView(row), created: true};
  });
  const read = (args, actor) => transaction(() => {
    const currentSession = session(args.session_id, actor);
    const row = scopedEntry(args.id, actor);
    audit('read', row.module_code, row.project_code, row.id, currentSession, actor);
    return {entry: entryView(row)};
  });
  const list = (args, actor) => transaction(() => {
    const currentSession = session(args.session_id, actor);
    const module = args.module === undefined ? null : moduleRow(args.module).code;
    const projects = args.project === undefined ? scope(actor).filter(activeProject) : [project(args.project, actor)];
    const limit = args.limit ?? 50, offset = args.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
      fail(400, 'Некорректная страница архива');
    }
    const modules = (module ? [moduleRow(module)] : db.prepare('SELECT * FROM module_archive_modules ORDER BY code').all()).map(card);
    const clauses = [projects.length ? `project_code IN (${projects.map(() => '?').join(',')})` : '0'];
    const params = [...projects];
    if (module) { clauses.push('module_code=?'); params.push(module); }
    const where = clauses.join(' AND ');
    const total = db.prepare(`SELECT count(*) n FROM module_archive_entries WHERE ${where}`).get(...params).n;
    const entries = db.prepare(`SELECT * FROM module_archive_entries WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(entryView);
    // Снимок scope не хранится в аудите. Логируем просмотр каждой пары, чтобы его
    // можно было учитывать впоследствии без выдачи журнала другого подключения.
    for (const item of modules) for (const projectCode of projects) audit('list', item.code, projectCode, null, currentSession, actor);
    if (!modules.length || !projects.length) audit('list', module, null, null, currentSession, actor);
    const usageGroups = `SELECT a.module_code module,a.project_code project,a.agent_id,a.owner_id,
      g.name agent_name,g.kind agent_kind,sum(a.operation IN ('list','read')) reads,sum(a.operation='write') writes,
      max(a.created_at) last_access_at FROM module_archive_access a LEFT JOIN agents g ON g.id=a.agent_id
      WHERE ${clauses.map(item => item.replace(/\b(project_code|module_code)\b/g, 'a.$1')).join(' AND ')} AND a.created_at>=?
      GROUP BY a.module_code,a.project_code,a.agent_id,a.owner_id`;
    const usageParams = [...params, new Date(now() - 7 * DAY).toISOString()];
    const usageTotal = db.prepare(`SELECT count(*) n FROM (${usageGroups})`).get(...usageParams).n;
    const usage = db.prepare(`${usageGroups} ORDER BY last_access_at DESC,module,project,owner_id,agent_id LIMIT ? OFFSET ?`)
      .all(...usageParams, limit, offset).map(row => ({module: row.module, project: row.project,
        agent: row.agent_id === null ? null : {id: row.agent_id, name: row.agent_name, kind: row.agent_kind},
        owner_id: row.owner_id, reads: row.reads, writes: row.writes, last_access_at: row.last_access_at}));
    return {modules, entries, pagination: {total, limit, offset}, usage,
      usage_pagination: {total: usageTotal, limit, offset}};
  });
  return {
    tool(name, args, actor) {
      owner(actor);
      if (!Object.hasOwn(KEYS, name)) fail(404, 'Инструмент архива не найден');
      if (!object(args) || Object.keys(args).some(key => !KEYS[name].includes(key))) fail(400, 'Неизвестное поле архива');
      if (!installed()) fail(503, 'Миграция архива модулей не установлена');
      if (name === 'archive_write') return write(args, actor);
      if (name === 'archive_read') return read(args, actor);
      return list(args, actor);
    },
    hints(request, actor) {
      if (!installed()) return [];
      owner(actor);
      const query = text(request, 4000, {empty: true}).toLocaleLowerCase('ru');
      return db.prepare('SELECT * FROM module_archive_modules ORDER BY code').all()
        .filter(row => KEYWORDS[row.code]?.some(keyword => query.includes(keyword)))
        .map(row => ({...card(row), tool: {name: 'archive_list', arguments: {module: row.code}}}));
    }
  };
}

module.exports = {createModuleArchive};
