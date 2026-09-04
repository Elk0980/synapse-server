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
const API_KEY = (process.env.API_KEY || '').trim();            // ключ владельца (Влад)
const EDITOR_KEY = (process.env.EDITOR_KEY || '').trim();      // ключ редактора (Татьяна)
const ASSETS_DIR = process.env.ASSETS_DIR || path.join(path.dirname(DATABASE_PATH), 'assets');
const MAX_ASSET = 8 * 1024 * 1024;
const ASSET_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
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

/* Возвращает имя автора по ключу: владелец или редактор. */
function requireKey(request) {
  if (!API_KEY && !EDITOR_KEY) fail(503, 'Запись отключена: на сервере не задан CONTENT_API_KEY');
  const given = (request.headers['x-api-key'] || '').toString().trim();
  if (API_KEY && given === API_KEY) return 'Влад';
  if (EDITOR_KEY && given === EDITOR_KEY) return 'Татьяна';
  fail(401, 'Неверный ключ доступа');
}

/* Проверка документа сайта: секции с id, поля key/value — строки, фон — объект. */
function validateSite(doc) {
  const problems = [];
  if (!Array.isArray(doc.sections)) problems.push('Нет списка секций sections');
  const ids = new Set();
  for (const sec of doc.sections || []) {
    if (!sec || typeof sec.id !== 'string' || !sec.id) { problems.push('У секции нет id'); continue; }
    if (ids.has(sec.id)) problems.push(`Повторяющийся id секции ${sec.id}`);
    ids.add(sec.id);
    for (const f of sec.fields || []) {
      if (!f || typeof f.key !== 'string') { problems.push(`Секция ${sec.id}: поле без key`); continue; }
      if (typeof f.value !== 'string') problems.push(`Поле ${f.key}: значение должно быть строкой`);
      if (f.value && f.value.length > 4000) problems.push(`Поле ${f.key}: длиннее 4000 символов`);
      if (/<\s*(script|iframe|object|style)/i.test(f.value || '')) problems.push(`Поле ${f.key}: недопустимая разметка`);
      if (f.href != null && !/^(https?:\/\/|mailto:|tel:|#|\/|[\w-]+\.html)/i.test(String(f.href))) problems.push(`Поле ${f.key}: недопустимая ссылка`);
      if (f.src != null && f.src !== '' && !/^(img\/|\/api\/assets\/|https:\/\/)[\w\-./%]+$/.test(String(f.src))) problems.push(`Поле ${f.key}: недопустимый путь к картинке`);
      if (f.layout != null && typeof f.layout !== 'object') problems.push(`Поле ${f.key}: layout должен быть объектом`);
      if (f.style != null) {
        if (typeof f.style !== 'object') problems.push(`Поле ${f.key}: style должен быть объектом`);
        else {
          if (f.style.font && !/^[\w ]{1,40}$/.test(f.style.font)) problems.push(`Поле ${f.key}: недопустимый шрифт`);
          if (f.style.size != null && !(Number(f.style.size) >= 50 && Number(f.style.size) <= 300)) problems.push(`Поле ${f.key}: размер от 50% до 300%`);
        }
      }
    }
    if (sec.background && typeof sec.background !== 'object') problems.push(`Секция ${sec.id}: фон должен быть объектом`);
    if (sec.background && sec.background.image && !/^(img\/|\/api\/assets\/|https:\/\/)[\w\-./%]+$/.test(sec.background.image)) {
      problems.push(`Секция ${sec.id}: недопустимый путь к фону`);
    }
  }
  if (problems.length) fail(422, 'Документ не прошёл проверку', problems);
}

function safeAssetName(name) {
  const base = String(name || 'image').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  return base;
}

async function readRaw(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, `Файл не должен превышать ${Math.round(limit / 1024 / 1024)} МБ`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

const VALIDATORS = { 'alvi/price': validatePrice, 'alvi/site': validateSite };

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
      'access-control-allow-headers': 'Content-Type, X-API-Key, X-Author, X-Filename',
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

    if (request.method === 'GET' && url.pathname === '/content/whoami') {
      const author = requireKey(request);
      return reply(200, { ok: true, author });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return reply(200, { ok: true, service: 'content' });
    }

    if (parts[0] !== 'content' || parts.length < 3) fail(404, 'Не найдено');

    // --- файлы (фоны блоков): /content/:site/assets[/:name]
    if (parts[2] === 'assets') {
      const site = parts[1].replace(/[^\w-]/g, '');
      const dir = path.join(ASSETS_DIR, site);
      if (request.method === 'GET' && parts.length === 4) {
        const file = path.join(dir, path.basename(parts[3]));
        if (!fs.existsSync(file)) fail(404, 'Файл не найден');
        const ext = path.extname(file).toLowerCase();
        const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        response.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', ...cors });
        return fs.createReadStream(file).pipe(response);
      }
      if (request.method === 'GET' && parts.length === 3) {
        const list = fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => ({ name: n, url: `/api/assets/${n}`, size: fs.statSync(path.join(dir, n)).size })) : [];
        return reply(200, { site, files: list });
      }
      if (request.method === 'POST' && parts.length === 3) {
        const author = requireKey(request);
        const type = (request.headers['content-type'] || '').split(';')[0].trim();
        if (!ASSET_TYPES[type]) fail(415, 'Допустимы только JPEG, PNG и WebP');
        const body = await readRaw(request, MAX_ASSET);
        if (!body.length) fail(400, 'Пустой файл');
        fs.mkdirSync(dir, { recursive: true });
        const original = decodeURIComponent(String(request.headers['x-filename'] || 'image')).replace(/\.[^.]+$/, '');
        const name = `${Date.now().toString(36)}-${safeAssetName(original)}${ASSET_TYPES[type]}`;
        fs.writeFileSync(path.join(dir, name), body);
        return reply(200, { ok: true, name, url: `/api/assets/${name}`, size: body.length, author });
      }
      fail(404, 'Не найдено');
    }

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
      const author = requireKey(request);
      const doc = await readJson(request);
      if (VALIDATORS[key]) VALIDATORS[key](doc);
      const saved = saveVersion(key, doc, author);
      return reply(200, { ok: true, key, ...saved });
    }

    // POST /content/:site/:doc/restore/:n — откат (по ключу)
    if (request.method === 'POST' && tail[0] === 'restore' && tail.length === 2) {
      const author = requireKey(request);
      const row = byVersionStmt.get(key, Number.parseInt(tail[1], 10));
      if (!row) fail(404, 'Версия не найдена');
      const saved = saveVersion(key, JSON.parse(row.body), `${author} (откат к ${row.version})`);
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
