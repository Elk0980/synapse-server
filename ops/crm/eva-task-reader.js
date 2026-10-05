'use strict';

// Opt-in, task-only local transport. Importing this module opens nothing.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MAX_TASKS = 10000;
const MAX_BYTES = 4 * 1024 * 1024;
const TASK_FIELDS = ['id', 'title', 'companyCode', 'companyName', 'status', 'dueAt',
  'nextAction', 'blocker', 'waitingForOwner'];

class ReaderError extends Error {
  constructor(code) { super(code); this.name = 'EvaTaskReaderError'; }
}

function approvedProjects(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
      || value.some(code => typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code))) {
    throw new ReaderError('invalid_config');
  }
  const projects = value.map(code => code.toLowerCase());
  if (new Set(projects).size !== projects.length) throw new ReaderError('invalid_config');
  return Object.freeze(projects);
}

function parseConfig(env = process.env, platform = process.platform) {
  const socketPath = env.EVA_TASK_SOCKET_PATH;
  const projectSetting = env.EVA_TASK_PROJECTS;
  if ((socketPath === undefined || socketPath === '') && (projectSetting === undefined || projectSetting === '')) return null;
  if (platform !== 'linux' || typeof socketPath !== 'string' || !path.posix.isAbsolute(socketPath)
      || socketPath.includes('\0') || socketPath.includes('\\') || socketPath.endsWith('/') || path.posix.normalize(socketPath) !== socketPath
      || Buffer.byteLength(socketPath) > 100 || !/^[a-zA-Z0-9_-]+\.sock$/.test(path.posix.basename(socketPath))
      || path.posix.dirname(socketPath) === '/' || typeof projectSetting !== 'string') {
    throw new ReaderError('invalid_config');
  }
  let decoded;
  try { decoded = JSON.parse(projectSetting); } catch { throw new ReaderError('invalid_config'); }
  return Object.freeze({ socketPath, projects: approvedProjects(decoded) });
}

function calendarDay(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'invalid';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : 'invalid';
}

function coordinationText(field) {
  return `CASE WHEN json_valid(c.data) THEN CASE WHEN json_type(c.data, '$.${field}') = 'text'
    THEN json_extract(c.data, '$.${field}') ELSE '' END ELSE '' END`;
}

function createProjection(db, approved) {
  const projects = approvedProjects(approved);
  try {
    const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    if (!hasTable('tasks') || !hasTable('companies')) throw new ReaderError('source_unavailable');
    const company = db.prepare('SELECT 1 FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0');
    if (projects.some(code => !company.get(code))) throw new ReaderError('source_unavailable');
    const coordination = hasTable('task_coordination');
    const dispatch = hasTable('task_dispatch');
    const query = db.prepare(`SELECT t.id,t.title,t.company_code,p.name AS company_name,t.status,t.due_date,t.assignee_role,
      ${coordination ? coordinationText('nextAction') : "''"} AS next_action,
      ${coordination ? coordinationText('blocker') : "''"} AS blocker,
      ${dispatch ? 'd.state' : 'NULL'} AS dispatch_state
      FROM tasks t JOIN companies p ON p.code=t.company_code COLLATE NOCASE AND p.is_deleted=0
      ${coordination ? 'LEFT JOIN task_coordination c ON c.task_id=t.id' : ''}
      ${dispatch ? 'LEFT JOIN task_dispatch d ON d.task_id=t.id AND d.company_code=t.company_code COLLATE NOCASE' : ''}
      WHERE t.is_deleted=0 AND t.company_code COLLATE NOCASE IN (${projects.map(() => '?').join(',')})
      ORDER BY t.id LIMIT ${MAX_TASKS + 1}`);
    return () => {
      const rows = query.all(...projects);
      if (rows.length > MAX_TASKS) throw new ReaderError('source_unavailable');
      return rows.map(row => ({ id: row.id, title: row.title, companyCode: row.company_code,
        companyName: row.company_name || row.company_code || 'Без проекта', status: row.status,
        dueAt: calendarDay(row.due_date), nextAction: row.next_action.trim(), blocker: row.blocker.trim(),
        waitingForOwner: ['done', 'cancelled'].includes(row.status) ? false
          : row.assignee_role === 'owner' || ['needs_input', 'review'].includes(row.dispatch_state) ? true : null }));
    };
  } catch { throw new ReaderError('source_unavailable'); }
}

function boundedTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) throw new ReaderError('source_unavailable');
  return tasks.map(task => {
    if (!task || !Number.isSafeInteger(task.id) || task.id <= 0
        || Object.entries({ title: 4096, companyCode: 256, companyName: 4096, status: 128,
          nextAction: 65536, blocker: 32768 }).some(([key, limit]) => typeof task[key] !== 'string' || task[key].length > limit)
        || !task.companyCode
        || !(task.dueAt === null || task.dueAt === 'invalid' || (typeof task.dueAt === 'string' && calendarDay(task.dueAt) === task.dueAt))
        || ![true, false, null].includes(task.waitingForOwner)) throw new ReaderError('source_unavailable');
    // Do not accidentally expose a field added later to the internal projection.
    return Object.fromEntries(TASK_FIELDS.map(key => [key, task[key]]));
  });
}

function createHandler({ readTasks, now = () => new Date() }) {
  if (typeof readTasks !== 'function' || typeof now !== 'function') throw new ReaderError('invalid_handler');
  return (request, response) => {
    const send = (status, data, extra = {}) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', connection: 'close', ...extra });
      response.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    if (request.method !== 'GET') return send(405, { error: 'method_not_allowed' }, { allow: 'GET' });
    if (request.url !== '/v1/tasks') return send(404, { error: 'not_found' });
    const headers = request.headers || {};
    if (headers['transfer-encoding'] !== undefined || (headers['content-length'] !== undefined && headers['content-length'] !== '0')) {
      return send(400, { error: 'body_not_allowed' });
    }
    let body;
    try {
      const tasks = boundedTasks(readTasks());
      const readAt = new Date(now()).toISOString();
      body = JSON.stringify({ version: 1, readAt, tasks });
      if (Buffer.byteLength(body) > MAX_BYTES) throw new ReaderError('source_unavailable');
    } catch { return send(503, { error: 'tasks_unavailable' }); }
    return send(200, body);
  };
}

function inspectSocketPath(socketPath, fsImpl, uid) {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new ReaderError('socket_unavailable');
  const parent = path.posix.dirname(socketPath);
  let current = '/';
  for (const part of ['', ...parent.slice(1).split('/')]) {
    if (part) current = path.posix.join(current, part);
    const stat = fsImpl.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)
        || (stat.uid !== 0 && stat.uid !== uid)) throw new ReaderError('socket_unavailable');
    if (current === parent && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)) throw new ReaderError('socket_unavailable');
  }
  // The shared directory must carry only this endpoint, never CRM files or other sockets.
  if (fsImpl.readdirSync(parent).length !== 0) throw new ReaderError('socket_unavailable');
  try { fsImpl.lstatSync(socketPath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new ReaderError('socket_unavailable');
}

async function startTaskReader({ db, env = process.env, platform = process.platform, fsImpl = fs,
  httpImpl = http, uid = process.getuid?.() } = {}) {
  const config = parseConfig(env, platform);
  if (!config) return null;
  let server;
  let ownedSocket;
  let closed = false;
  let ready = false;
  let closePromise;
  function removeOwnedSocket() {
    if (!ownedSocket) return;
    let current;
    try { current = fsImpl.lstatSync(config.socketPath); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (current.isSocket() && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) fsImpl.unlinkSync(config.socketPath);
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    ready = false;
    closePromise = new Promise((resolve, reject) => {
      const finish = () => {
        try { removeOwnedSocket(); resolve(); } catch { reject(new ReaderError('socket_unavailable')); }
      };
      // Native Node/libuv close also unlinks the bound path. The trusted owner must
      // stop this service before replacing the socket or its dedicated directory.
      if (server?.listening) { server.close(finish); server.closeAllConnections?.(); }
      else finish();
    });
    return closePromise;
  }
  try {
    inspectSocketPath(config.socketPath, fsImpl, uid);
    const readTasks = createProjection(db, config.projects);
    // Probe before opening transport; no migrate/reconcile/query_only changes to CRM's connection.
    boundedTasks(readTasks());
    server = httpImpl.createServer(createHandler({ readTasks: () => {
      if (!ready) throw new ReaderError('source_unavailable');
      return readTasks();
    } }));
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    server.maxRequestsPerSocket = 1;
    server.maxConnections = 4;
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    ownedSocket = fsImpl.lstatSync(config.socketPath);
    if (!ownedSocket.isSocket() || ownedSocket.uid !== uid) throw new ReaderError('socket_unavailable');
    fsImpl.chmodSync(config.socketPath, 0o600);
    const checked = fsImpl.lstatSync(config.socketPath);
    if (!checked.isSocket() || checked.dev !== ownedSocket.dev || checked.ino !== ownedSocket.ino
        || checked.uid !== uid || (checked.mode & 0o777) !== 0o600) throw new ReaderError('socket_unavailable');
    server.on('error', () => { if (!closed) void close().catch(() => {}); });
    ready = true;
    return { close };
  } catch {
    try { await close(); } catch {}
    throw new ReaderError('socket_unavailable');
  }
}

module.exports = { parseConfig, createProjection, createHandler, startTaskReader };
