'use strict';

/* Synapse Business — сервис контента сайтов.
   Хранит JSON-документы (например, прайс ALVI) с историей версий.
   Чтение публичное, запись — по ключу X-API-Key (CONTENT_API_KEY в .env).
   Внешних пакетов нет: Node 24, встроенный node:sqlite. */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/content.sqlite';
const API_KEY = (process.env.API_KEY || '').trim();
const SEED_DIR = process.env.SEED_DIR || path.join(__dirname, 'seed');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const HISTORY_LIMIT = 10;
const MAX_BODY = 1024 * 1024;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535');
}
if (!API_KEY) {
  console.warn('content: API_KEY пуст — запись отключена, доступно только чтение');
}

const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    author TEXT,
    body TEXT NOT NULL,
    UNIQUE (key, version)
  );
  CREATE INDEX IF NOT EXISTS documents_key_idx ON documents(key, version DESC);
`);

const latestStmt = db.prepare('SELECT * FROM documents WHERE key = ? ORDER BY version DESC LIMIT 1');
const byVersionStmt = db.prepare('SELECT * FROM documents WHERE key = ? AND version = ?');
const historyStmt = db.prepare(
  'SELECT version, created_at, author, length(body) AS size FROM documents WHERE key = ? ORDER BY version DESC LIMIT ?'
);
const insertStmt = db.prepare(
  'INSERT INTO documents (key, version, created_at, author, body) VALUES (?, ?, ?, ?, ?)'
);

/* Первичное наполнение: seed/<site>-<doc>.json кладётся как версия 1, если документа ещё нет. */
function seedDocuments() {
  if (!fs.existsSync(SEED_DIR)) return;
  for (const file of fs.readdirSync(SEED_DIR)) {
    if (!file.endsWith('.json')) continue;
    const key = file.replace(/\.json$/, '').replace('-', '/');
    const latest = latestStmt.get(key);
    // Пока документ никто не правил руками (все версии — seed), обновлённый seed из репозитория
    // становится новой версией. После первого сохранения из кабинета seed больше не вмешивается.
    if (latest && latest.author !== 'seed') continue;
    try {
      const raw = fs.readFileSync(path.join(SEED_DIR, file), 'utf8');
      JSON.parse(raw);
      if (latest && latest.body === raw) continue;
      insertStmt.run(key, latest ? latest.version + 1 : 1, new Date().toISOString(), 'seed', raw);
      console.log(`content: документ ${key} ${latest ? 'обновлён' : 'создан'} из seed`);
    } catch (error) {
      console.error(`content: seed ${file} пропущен — ${error.message}`);
    }
  }
}
seedDocuments();

function send(response, status, payload, extraHeaders) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  response.end(body);
}

function fail(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  throw error;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Документ не должен превышать 1 МБ');
    chunks.push(chunk);
  }
  if (chunks.length === 0) fail(400, 'Ожидалось тело запроса в формате JSON');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      fail(400, 'Тело запроса должно быть JSON-объектом');
    }
    return value;
  } catch (error) {
    if (error.status) throw error;
    fail(400, 'Некорректный JSON');
  }
}

function requireKey(request) {
  if (!API_KEY) fail(503, 'Запись отключена: на сервере не задан CONTENT_API_KEY');
  const given = (request.headers['x-api-key'] || '').toString().trim();
  if (given !== API_KEY) fail(401, 'Неверный ключ доступа');
}

/* Проверка прайса: лимиты «не больше 8», уникальные id, ссылки витрины на существующие позиции. */
function validatePrice(doc) {
  const problems = [];
  if (!Array.isArray(doc.categories)) problems.push('Нет списка разделов categories');
  const ids = new Set();
  for (const cat of doc.categories || []) {
    if (!cat || typeof cat.id !== 'string' || !cat.id.trim()) { problems.push('У раздела нет id'); continue; }
    if (typeof cat.title !== 'string' || !cat.title.trim()) problems.push(`Раздел ${cat.id}: пустое название`);
    if (!['programs', 'table'].includes(cat.kind)) problems.push(`Раздел ${cat.id}: неизвестный тип ${cat.kind}`);
    if (!['self', 'two'].includes(cat.block)) problems.push(`Раздел ${cat.id}: блок главной должен быть self или two`);
    if (ids.has(cat.id)) problems.push(`Повторяющийся id ${cat.id}`);
    ids.add(cat.id);
    for (const it of cat.items || []) {
      if (!it || typeof it.id !== 'string' || !it.id.trim()) { problems.push(`Раздел ${cat.id}: у позиции нет id`); continue; }
      if (ids.has(it.id)) problems.push(`Повторяющийся id ${it.id}`);
      ids.add(it.id);
      if (typeof it.title !== 'string' || !it.title.trim()) problems.push(`Позиция ${it.id}: пустое название`);
    }
  }
  const showcase = doc.showcase || {};
  for (const block of ['self', 'two']) {
    const list = showcase[block] || [];
    if (!Array.isArray(list)) { problems.push(`Витрина ${block} должна быть списком id`); continue; }
    const max = Number(doc.blocks?.[block]?.max) || 8;
    if (list.length > max) problems.push(`Витрина ${block}: больше ${max} позиций (${list.length})`);
    for (const id of list) if (!ids.has(id)) problems.push(`Витрина ${block}: позиции ${id} нет в прайсе`);
    if (new Set(list).size !== list.length) problems.push(`Витрина ${block}: позиции повторяются`);
  }
  // «до 8 популярных в разделе»
  for (const cat of doc.categories || []) {
    const popular = (cat.items || []).filter((it) => (showcase.self || []).includes(it.id) || (showcase.two || []).includes(it.id));
    if (popular.length > 8) problems.push(`Раздел ${cat.id}: отмечено больше 8 популярных (${popular.length})`);
  }
  if (problems.length) fail(422, 'Документ не прошёл проверку', problems);
}

const VALIDATORS = { 'alvi/price': validatePrice };

function nextVersion(key) {
  const latest = latestStmt.get(key);
  return latest ? latest.version + 1 : 1;
}

function saveVersion(key, doc, author) {
  const version = nextVersion(key);
  const now = new Date().toISOString();
  const body = JSON.stringify({ ...doc, version, updatedAt: now });
  insertStmt.run(key, version, now, author || null, body);
  return { version, updatedAt: now };
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-API-Key, X-Author',
      'vary': 'Origin',
    };
  }
  return {};
}

const server = http.createServer(async (request, response) => {
  const cors = corsHeaders(request);
  const reply = (status, payload, extra) => send(response, status, payload, { ...cors, ...(extra || {}) });
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      return response.end();
    }
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method === 'GET' && url.pathname === '/health') {
      return reply(200, { ok: true, service: 'content' });
    }

    if (parts[0] !== 'content' || parts.length < 3) fail(404, 'Не найдено');
    const key = `${parts[1]}/${parts[2]}`;
    const tail = parts.slice(3);

    // GET /content/:site/:doc — актуальная версия (публично)
    if (request.method === 'GET' && tail.length === 0) {
      const row = latestStmt.get(key);
      if (!row) fail(404, `Документ ${key} не найден`);
      return reply(200, row.body, { etag: `"${row.version}"` });
    }

    // GET /content/:site/:doc/history
    if (request.method === 'GET' && tail[0] === 'history' && tail.length === 1) {
      return reply(200, { key, versions: historyStmt.all(key, HISTORY_LIMIT) });
    }

    // GET /content/:site/:doc/version/:n
    if (request.method === 'GET' && tail[0] === 'version' && tail.length === 2) {
      const row = byVersionStmt.get(key, Number.parseInt(tail[1], 10));
      if (!row) fail(404, 'Версия не найдена');
      return reply(200, row.body);
    }

    // PUT /content/:site/:doc — новая версия (по ключу)
    if (request.method === 'PUT' && tail.length === 0) {
      requireKey(request);
      const doc = await readJson(request);
      if (VALIDATORS[key]) VALIDATORS[key](doc);
      const saved = saveVersion(key, doc, request.headers['x-author'] ? String(request.headers['x-author']).slice(0, 80) : 'cabinet');
      return reply(200, { ok: true, key, ...saved });
    }

    // POST /content/:site/:doc/restore/:n — откат (по ключу)
    if (request.method === 'POST' && tail[0] === 'restore' && tail.length === 2) {
      requireKey(request);
      const row = byVersionStmt.get(key, Number.parseInt(tail[1], 10));
      if (!row) fail(404, 'Версия не найдена');
      const saved = saveVersion(key, JSON.parse(row.body), `restore:${row.version}`);
      return reply(200, { ok: true, key, restoredFrom: row.version, ...saved });
    }

    fail(404, 'Не найдено');
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    reply(status, { error: error.message, details: error.details || undefined });
  }
});

server.listen(PORT, () => {
  console.log(`content: слушает порт ${PORT}, база ${DATABASE_PATH}`);
});
