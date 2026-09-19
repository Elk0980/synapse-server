'use strict';

/* Synapse Business — сервис контента сайтов.
   Хранит JSON-документы (например, прайс ALVI) с историей версий.
   Кабинет проверяет сессию, проект и права; сайты читают отдельный публичный маршрут.
   Внешних пакетов нет: Node 24, встроенный node:sqlite. */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore, COMPANIES, PERMISSIONS, DEPENDENCIES, PRICE_CLIENT_PRESET } = require('./auth-store');
const { createSiteStore } = require('./site-store');
const { createHughSettingsStore } = require('./hugh-settings-store');
const { createProjectChat } = require('./project-chat');
const { createHughProviders } = require('./hugh-providers');
const { clientIp, originOf } = require('./site-orders');
const { hashPassword, verifyPassword } = require('./passwords');
const { createCompanyLinksReader } = require('./company-links-reader');
const { createEmailUnsubscribeProxy, TOKEN: EMAIL_UNSUBSCRIBE_TOKEN } = require('./email-unsubscribe-proxy');
const { resolveSessionSecret } = require('./session-secret');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/content.sqlite';
const API_KEY = (process.env.API_KEY || '').trim();            // ключ владельца (Влад)
const ASSETS_DIR = process.env.ASSETS_DIR || path.join(path.dirname(DATABASE_PATH), 'assets');
const MAX_ASSET = 8 * 1024 * 1024;
const MAX_PUBLISHING_ASSET = 10 * 1024 * 1024;
// Видео для очереди контента: вертикальные ролики до 60 МБ. Проверяется контейнер по сигнатуре, не по расширению.
const MAX_PUBLISHING_VIDEO = Number.parseInt(process.env.MAX_PUBLISHING_VIDEO_BYTES || '', 10) || 60 * 1024 * 1024;
const PUBLISHING_ASSET_ORIGIN = 'https://synapse.synapsebusiness.ru';
const ASSET_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm' };
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const ASSET_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };
const SEED_DIR = process.env.SEED_DIR || path.join(__dirname, 'seed');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const HISTORY_LIMIT = 10;
const MAX_BODY = 1024 * 1024;
const SITES = new Set(['alvi', 'avokado', 'avokado2', 'avokado3', 'palitra']);
const DOCUMENT_VALIDATORS = { site: validateSite, price: validatePrice };
const OWNER_DOCUMENTS = new Map([['synapse-business/trademarks', validateMarkdown]]);
const CONTENT_COMPANIES = { alvi: 'alvi', avokado: 'avokado', avokado2: 'avokado', avokado3: 'avokado', palitra: 'palitra-love' };
const SESSION_TTL = 30 * 24 * 60 * 60;
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_LIMIT = 10;
// Ключ подписи сессий: переменная окружения главнее, иначе постоянный приватный файл рядом с базой.
const SESSION_SECRET = resolveSessionSecret({
  envSecret: process.env.SESSION_SECRET,
  databasePath: DATABASE_PATH,
  onEvent: (event, { file }) => console.warn(event === 'created'
    ? `content: SESSION_SECRET не задан — создан постоянный ключ подписи сессий ${file}; потребуется один повторный вход`
    : `content: SESSION_SECRET не задан — используется сохранённый ключ подписи сессий ${file}`),
}).secret;
const CRM_URL = (process.env.CRM_URL || 'http://crm:8080').replace(/\/$/, '');
const CRM_API_KEY = (process.env.CRM_API_KEY || '').trim();
const readCompanyLinks = createCompanyLinksReader({crmUrl: CRM_URL, apiKey: CRM_API_KEY, companies: CONTENT_COMPANIES});
const publicEmailUnsubscribe = createEmailUnsubscribeProxy({crmUrl: CRM_URL, apiKey: CRM_API_KEY});
const CHAT_URL = (process.env.CHAT_URL || 'http://chat:8080').replace(/\/$/, '');
const CHAT_API_KEY = (process.env.CHAT_API_KEY || '').trim();
const HUGH_RUNTIME_URL = (process.env.HUGH_RUNTIME_URL || 'http://hugh-runtime:8080').replace(/\/$/, '');
// Локальный обработчик Хью на компьютере владельца: хеш его ключа и компании, обслуживаемые только им.
const HUGH_LOCAL_WORKER_KEY_SHA256 = (process.env.HUGH_LOCAL_WORKER_KEY_SHA256 || '').trim();
const HUGH_LOCAL_WORKER_COMPANIES = (process.env.HUGH_LOCAL_WORKER_COMPANIES || '').split(',').map((s) => s.trim()).filter(Boolean);
// Telegram Mini App чата проекта: несекретный числовой ID бота для проверки подписи Telegram. Пусто — вход отключён.
const TELEGRAM_BOT_ID = (process.env.TELEGRAM_BOT_ID || '').trim();
const CRM_IDENTITY_HEADER = 'x-synapse-crm-identity';
const loginFailures = new Map();

/* Ответ службы Хью для кабинета: только известные поля и короткие строки,
   без произвольного текста стороннего сервера и без ключей. */
function sanitizeRuntime(payload) {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const text = (value, limit) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, limit);
  const link = String(data.loginUrl || data.verificationUrl || '');
  return {
    connected: data.connected === true,
    authenticated: data.authenticated === true,
    configured: true,
    state: text(data.state, 40) || 'unknown',
    provider: text(data.provider, 40) || 'codex',
    model: text(data.model, 60),
    loginUrl: /^https:\/\/(?:[\w-]+\.)*(?:openai|chatgpt)\.com\/[^\s"'<>]*$/.test(link) && link.length <= 300 ? link : '',
    userCode: /^[A-Za-z0-9-]{1,32}$/.test(String(data.userCode || '')) ? String(data.userCode) : '',
    error: text(data.error, 200),
  };
}

function logAuthorizationDenial(request, error) {
  const session = sessionData(request);
  const login = String(error.login || session?.user?.login || 'неизвестен').replace(/[\r\n\t]/g, ' ');
  const route = String(request.url || '/').split('?')[0].replace(/[\r\n\t]/g, ' ');
  const reason = String(error.message || 'Отказано').replace(/[\r\n\t]/g, ' ');
  console.warn(`content: authorization_denied time=${new Date().toISOString()} login=${JSON.stringify(login)} route=${JSON.stringify(route)} reason=${JSON.stringify(reason)}`);
}

function logAccountMutation(action, actor, target, before, after) {
  console.log(`content: account_${action} time=${new Date().toISOString()} actor=${JSON.stringify(actor.login)}` +
    ` target=${JSON.stringify(target.login)} old_companies=${JSON.stringify(before.companyCodes)}` +
    ` new_companies=${JSON.stringify(after?.companyCodes || [])}` +
    ` old_permissions=${JSON.stringify(before.permissions)} new_permissions=${JSON.stringify(after?.permissions || [])}`);
}

function publicIdentity(identity) {
  return {
    userId: identity.id, login: identity.login, displayName: identity.displayName,
    author: identity.displayName, role: identity.role, companies: identity.companies,
    permissions: identity.permissions,
    sites: identity.companies.map((company) => company.contentSiteId).filter(Boolean),
  };
}

function crmIdentityHeader(identity) {
  return Buffer.from(JSON.stringify({
    v: 1,
    userId: identity.id,
    role: identity.role,
    userName: identity.displayName || identity.login,
    permissions: identity.permissions,
    companyCodes: identity.companyCodes,
  })).toString('base64url');
}

function b64url(value) { return Buffer.from(value).toString('base64url'); }
function signature(payload) { return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'); }
function makeSession(identity) {
  const payload = b64url(JSON.stringify({ uid: identity.id, sessionVersion: identity.sessionVersion,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL, csrf: crypto.randomBytes(24).toString('base64url') }));
  return `${payload}.${signature(payload)}`;
}
function sessionData(request) {
  const cookies = Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split(/=(.*)/s)).filter(([key]) => key));
  const [payload, sig] = String(cookies.synapse_session || '').split('.');
  if (!payload || !sig) return null;
  const expected = signature(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const token = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (token.exp < Math.floor(Date.now() / 1000)) return null;
    const current = authStore.getById(token.uid);
    if (!current || current.sessionVersion !== token.sessionVersion) return null;
    return { user: current, csrf: token.csrf };
  } catch { return null; }
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535');
}
if (!API_KEY) {
  console.warn('content: API_KEY пуст — запасной вход по ключу владельца отключён');
}

const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
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
const authStore = createAuthStore(db, process.env.AUTH_USERS || '');
const hughSettingsStore = createHughSettingsStore(db);
// Заявки с сайта принимаются только для Palitra: сайт задаёт Caddy, список Origin — точный allowlist.
const ORDER_SITES = { palitra: { companyCode: CONTENT_COMPANIES.palitra, title: 'Palitra',
  origins: (process.env.PALITRA_ORDER_ORIGINS || 'https://palitra-love.synapsebusiness.ru').split(',').map((s) => s.trim()).filter(Boolean) } };
const ORDER_BODY_LIMIT = 32 * 1024;
/* Защищённое хранилище ключей провайдеров Хью: владелец вводит ключ в ЛК, ключ шифруется
   внешним мастер-ключом и наружу не возвращается. Без мастер-ключа хранилище закрыто. */
const hughProviders = createHughProviders({ db });
const projectChat = createProjectChat({ db, authStore, assetsDir: ASSETS_DIR,
  fallback: { providerStore: hughProviders },
  runnerUrl: HUGH_RUNTIME_URL, chatUrl: CHAT_URL, chatApiKey: CHAT_API_KEY,
  localWorker: { keySha256: HUGH_LOCAL_WORKER_KEY_SHA256, companies: HUGH_LOCAL_WORKER_COMPANIES },
  // Соль для хеша IP выводится из секрета сессий: сам IP не хранится, отдельного секрета не нужно.
  siteOrders: { sites: ORDER_SITES, priceReader: (site) => latestStmt.get(`${site}/price`)?.body ?? null,
    ipSalt: crypto.createHash('sha256').update(`site-orders-ip:${SESSION_SECRET}`).digest('hex') },
  miniApp: { botId: TELEGRAM_BOT_ID, sessionSecret: SESSION_SECRET },
  // Команды Хью в группах: сводка плана берётся из CRM тем же служебным ключом; имя бота — не секрет.
  crmUrl: CRM_URL, crmApiKey: CRM_API_KEY, botUsername: (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, ''),
  cabinetUrl: (process.env.CABINET_PUBLIC_URL || 'https://synapse.synapsebusiness.ru/cabinet.html').trim(),
  requireSession, requireCsrf, sendJson: send, readBody: readJson });
for (const issue of [...projectChat.localWorker.issues, ...projectChat.miniApp.issues]) console.warn(`content: ${issue}`);

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
    const stem = file.replace(/\.json$/, '');
    const key = stem === 'synapse-business-trademarks' ? 'synapse-business/trademarks' : stem.replace('-', '/');
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

/* Возвращает имя автора по ключу владельца или сессии кабинета. */
function requireAuth(request, site) {
  const given = (request.headers['x-api-key'] || '').toString().trim();
  if (API_KEY && given === API_KEY) return { author: 'system-owner' };
  let identity;
  if (!given) identity = sessionData(request)?.user;
  if (!identity) fail(401, given ? 'Неверный ключ доступа' : 'Требуется вход в кабинет или ключ доступа');
  if (identity.id && site && identity.role !== 'owner' && !identity.companyCodes.includes(CONTENT_COMPANIES[site])) {
    fail(403, 'У вашей учётной записи нет доступа к этому сайту');
  }
  return publicIdentity(identity);
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
      if (it.oldPrice != null && typeof it.oldPrice !== 'string') problems.push(`Позиция ${it.id}: старая цена должна быть строкой`);
      if (it.quizEnabled != null && typeof it.quizEnabled !== 'boolean') problems.push(`Позиция ${it.id}: признак участия в квизе должен быть логическим`);
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

function validateMarkdown(doc) {
  if (Object.keys(doc).join(',') !== 'markdown' || typeof doc.markdown !== 'string') {
    fail(422, 'Markdown-документ должен содержать только строку markdown');
  }
}

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

const siteStore = createSiteStore(db, authStore, saveVersion);

function requireSession(request) {
  const session = sessionData(request);
  if (!session) fail(401, 'Требуется вход в кабинет');
  return session;
}

function requirePermission(request, permission, companyCode, obscure = false) {
  const session = requireSession(request);
  const user = session.user;
  if (user.role !== 'owner' && !user.permissions.includes(permission)) fail(403, 'Недостаточно прав');
  if (companyCode && user.role !== 'owner' && !user.companyCodes.includes(companyCode)) {
    fail(obscure ? 404 : 403, obscure ? 'Объект не найден' : 'Нет доступа к компании');
  }
  return session;
}

// Cabinet access never trusts the presence of an API-key header: validate its value.
function requireContentAccess(request, permission, site, write = false) {
  if (request.headers['x-api-key']) return requireAuth(request, site);
  const session = requirePermission(request, permission, CONTENT_COMPANIES[site]);
  if (write) requireCsrf(request, session);
  return publicIdentity(session.user);
}

function requireCsrf(request, session) {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) fail(403, 'Некорректный CSRF-токен');
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-API-Key, X-Author, X-Filename, X-File-Name, X-CSRF-Token',
      'vary': 'Origin',
    };
  }
  return {};
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Документ не должен превышать 1 МБ');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function crmLeadCompany(id) {
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(`${CRM_URL}/leads/${id}`, { headers: { 'x-api-key': CRM_API_KEY } });
  } catch (error) {
    console.error('content: ошибка проверки заявки CRM:', error);
    fail(502, 'CRM недоступна');
  }
  if (!upstreamResponse.ok) fail(404, 'Заявка не найдена');
  try {
    return (await upstreamResponse.json()).companyCode;
  } catch {
    fail(502, 'Некорректный ответ CRM');
  }
}

async function crmCompanyOwnerScope(id) {
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(`${CRM_URL}/companies/${id}?includeDeleted=true`, {
      headers: { 'x-api-key': CRM_API_KEY },
    });
  } catch (error) {
    console.error('content: ошибка проверки владельца карточки CRM:', error);
    fail(502, 'CRM недоступна');
  }
  if (!upstreamResponse.ok) fail(404, 'Компания не найдена');
  try {
    return (await upstreamResponse.json()).ownerScope;
  } catch {
    fail(502, 'Некорректный ответ CRM');
  }
}

async function proxyCrm(request, response, url, cors) {
  const initialSession = requireSession(request);
  const identity = initialSession.user;
  const readOnly = request.method === 'GET';
  const crmPath = url.pathname.slice('/content/crm'.length) || '/';
  if (/^\/vk-community(?:\/|$)/.test(crmPath)) {
    if (identity.role !== 'owner') fail(403,'Подключение и сообщения ВК доступны владельцу');
    const code = url.searchParams.get('companyCode');
    if (!code || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail(400,'Выберите компанию');
  }
  // Испытания моделей — часть того же owner-only раздела: цены и аккаунты клиентам не показываем.
  if (/^\/(catalog|finances|ai-trials)(?:\/|$)/.test(crmPath) && identity.role !== 'owner') fail(403,'Коммерческие условия и финансы доступны владельцу');
  const companyModule = /^\/(company-information|autoposting)(?:\/|$)/.exec(crmPath)?.[1];
  if (/^\/(?:studio-journey|reviews|platform-demand|social-stats)(?:\/|$)/.test(crmPath)) {
    const code=url.searchParams.get('companyCode');
    if (!code || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail(400,'Выберите компанию');
    if(identity.role!=='owner')requirePermission(request,readOnly?(/^\/(?:platform-demand|social-stats)/.test(crmPath)?'analytics.view':'crm.view'):'crm.edit',code);
    if (/^\/social-stats\/(?:accounts|import)$/.test(crmPath) && !readOnly && identity.role!=='owner') fail(403,'Настройки аккаунтов и ручной импорт доступны владельцу');
  }
  if (/^\/autoposting\/posts\/\d+\/(?:approve|reject)$/.test(crmPath) && identity.role!=='owner') fail(403,'Согласовывать и отклонять публикации может только владелец');
  // Отметка «опубликовано вне ЛК» — решение владельца компании; права редактора недостаточно.
  if (/^\/autoposting\/posts\/\d+\/receipts$/.test(crmPath) && identity.role!=='owner') fail(403,'Отмечать публикацию вне кабинета может только владелец');
  if (crmPath==='/autoposting/plan-summary') fail(404,'Адрес не найден');
  if (/^\/autoposting\/settings\/[^/]+\/profiles$/.test(crmPath) && identity.role!=='owner') {
    fail(403,'Профили общего аккаунта публикаций настраивает владелец');
  }
  if (companyModule) {
    const code = url.searchParams.get('companyCode');
    if (!code || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail(400, 'Выберите компанию');
    if (identity.role !== 'owner') {
      requirePermission(request, `${companyModule}.${readOnly ? 'view' : 'edit'}`, code);
    }
  }
  // Внедрение Медиа-наставника: этапы ведёт администратор Synapse, клиент читает их
  // и отвечает на опрос ЛК по уже выданному праву раздела публикаций своей компании.
  const mentorRollout = /^\/media-mentor-rollout(?:\/|$)/.test(crmPath);
  if (mentorRollout) {
    const code = url.searchParams.get('companyCode');
    if (!code || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail(400, 'Выберите компанию');
    if (identity.role !== 'owner') {
      if (crmPath !== '/media-mentor-rollout/survey' && !readOnly) {
        fail(403, 'Этапы внедрения ведёт администратор Synapse');
      }
      requirePermission(request, 'autoposting.view', code);
    }
  }
  // Бриф и контент-план Медиа-наставника переиспользуют права автопостинга: новых прав нет.
  // Согласование версии плана — решение владельца и не даёт разрешения публиковать.
  const mentorPlan = /^\/media-mentor(?:\/|$)/.test(crmPath);
  if (mentorPlan) {
    const code = url.searchParams.get('companyCode');
    if (!code || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail(400, 'Выберите компанию');
    if (crmPath === '/media-mentor/plan/decision' && identity.role !== 'owner') {
      fail(403, 'Согласовывать и отклонять план может только владелец');
    }
    if (identity.role !== 'owner') {
      requirePermission(request, `autoposting.${readOnly ? 'view' : 'edit'}`, code);
    }
  }
  if (/^\/(?:email-campaigns|email-subscriptions)(?:\/|$)/.test(crmPath) && identity.role !== 'owner') {
    fail(403, 'Рассылки доступны только владельцу');
  }
  if (['/company-email', '/email-status', '/email-settings', '/email-settings/check'].includes(crmPath) && identity.role !== 'owner') {
    fail(403, 'Настройки и диагностика почты доступны только владельцу');
  }
  const analyticsReadPath = /^\/(?:platform-demand|social-stats)(?:\/|$)/.test(crmPath) || new Set([
    '/dashboard', '/summary', '/external-stats', '/expenses', '/tasks/summary',
  ]).has(crmPath);
  let session = initialSession;
  if (identity.role !== 'owner' && identity.companyCodes.length === 0) {
    fail(403, 'Аккаунту не назначена компания');
  }
  if (identity.role !== 'owner' && !companyModule && !mentorRollout && !mentorPlan) {
    if (readOnly) {
      const permission = analyticsReadPath && identity.permissions.includes('analytics.view')
        ? 'analytics.view' : 'crm.view';
      session = requirePermission(request, permission);
    } else {
      session = requirePermission(request, 'crm.edit');
    }
  }
  if (!readOnly) requireCsrf(request, session);

  const clientDatabasePath = /^\/(?:contacts|companies|legal-entities|tasks|deals)(?:\/|$)/.test(crmPath) &&
    crmPath !== '/tasks/summary';
  const companyOverview = /^\/companies\/\d+\/overview$/.test(crmPath);
  const ownerOnlyPipelinePath = /^\/(?:pipeline-stages|pipelines|pipeline-rules)(?:\/|$)/.test(crmPath) ||
    /^\/companies\/\d+\/(?:overview|pipeline|service)(?:\/|$)/.test(crmPath);
  if (ownerOnlyPipelinePath && identity.role !== 'owner') {
    fail(403, 'Воронка и сервисные поля доступны только владельцу');
  }
  if (identity.role !== 'owner' && clientDatabasePath && !companyOverview) {
    const requestedCompany = url.searchParams.get('companyCode');
    if (!requestedCompany) fail(400, 'Уточните компанию');
    if (!identity.companyCodes.some(
      (code) => code.toLowerCase() === requestedCompany.toLowerCase()
    )) fail(403, 'Нет доступа к компании');
  }

  const companyScoped = /^\/(?:leads(?:\/|\.|$)|dashboard(?:\/|$)|summary(?:\/|$)|expenses(?:\/|$)|external-stats(?:\/|$)|tasks\/summary$)/.test(crmPath);
  if (identity.role !== 'owner' && companyScoped) {
    const requestedCompany = url.searchParams.get('companyCode');
    if (requestedCompany && !identity.companyCodes.includes(requestedCompany.toLowerCase())) {
      fail(403, 'Нет доступа к компании');
    }
    if (!requestedCompany && identity.companyCodes.length > 1) fail(403, 'Уточните компанию');
    if (!requestedCompany) url.searchParams.set('companyCode', identity.companyCodes[0]);
  }
  if (!CRM_API_KEY) fail(503, 'Прокси CRM не настроен');
  if (identity.role !== 'owner' && crmPath === '/expenses' && request.method !== 'GET') {
    fail(403, 'Расходы вносит владелец');
  }
  const leadMatch = crmPath.match(/^\/leads\/(\d+)(?:\/|$)/);
  let requestBody = null;
  const companyWrite = (request.method === 'POST' && crmPath === '/companies') ||
    (request.method === 'PATCH' && /^\/companies\/\d+$/.test(crmPath));
  const externalStatsWrite = crmPath === '/external-stats' && request.method !== 'GET';
  if (identity.role !== 'owner' && (companyWrite || externalStatsWrite)) {
    requestBody = await readRequestBody(request);
    let body;
    try { body = JSON.parse(requestBody.toString('utf8')); } catch { fail(400, 'Некорректный JSON'); }
    if (externalStatsWrite && body && typeof body === 'object' &&
      !identity.companyCodes.some((code) => code.toLowerCase() === String(body.companyCode || '').toLowerCase())) {
      fail(403, 'Нет доступа к компании');
    }
    if (body && typeof body === 'object' && Object.hasOwn(body, 'pipelineStage')) {
      fail(403, 'Воронка и сервисные поля доступны только владельцу');
    }
  }
  const companyMutation = crmPath.match(/^\/companies\/(\d+)$/);
  if (identity.role !== 'owner' && companyMutation && ['PATCH', 'DELETE'].includes(request.method)) {
    const ownerScope = await crmCompanyOwnerScope(companyMutation[1]);
    const requestedCompany = url.searchParams.get('companyCode');
    if (!requestedCompany || ownerScope?.toLowerCase() !== requestedCompany.toLowerCase()) {
      fail(403, 'Карточка компании принадлежит другой базе');
    }
  }
  if (leadMatch && url.searchParams.get('companyCode')) {
    const leadCompany=await crmLeadCompany(leadMatch[1]);
    if(leadCompany?.toLowerCase()!==url.searchParams.get('companyCode').toLowerCase()) fail(404,'Заявка не найдена в выбранной компании');
  }
  if (identity.role !== 'owner' && leadMatch) {
    const leadCompany = await crmLeadCompany(leadMatch[1]);
    const allowed = leadCompany && identity.companyCodes.some((code) => {
      return code.toLowerCase() === leadCompany.toLowerCase();
    });
    if (!allowed) fail(404, 'Заявка не найдена');
    if (request.method === 'PATCH' && crmPath === `/leads/${leadMatch[1]}`) {
      requestBody = await readRequestBody(request);
      let body;
      try { body = JSON.parse(requestBody.toString('utf8')); } catch { fail(400, 'Некорректный JSON'); }
      if (body && typeof body === 'object' && Object.hasOwn(body, 'companyCode')) {
        fail(403, 'Смена компании доступна только владельцу');
      }
    }
  }
  const target = new URL(`${CRM_URL}${crmPath}${url.search}`);
  const headers = { ...request.headers, host: target.host, 'x-api-key': CRM_API_KEY };
  delete headers.cookie;
  // CRM accepts this header as trusted context, so caller-supplied claims must never pass through.
  delete headers[CRM_IDENTITY_HEADER];
  headers[CRM_IDENTITY_HEADER] = crmIdentityHeader(identity);
  if (requestBody) headers['content-length'] = requestBody.length;
  const upstream = http.request(target, { method: request.method, headers }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers, ...cors };
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    console.error('content: ошибка прокси CRM:', error);
    if (!response.headersSent) send(response, 502, { error: 'CRM недоступна' }, cors);
    else response.destroy(error);
  });
  if (requestBody) upstream.end(requestBody);
  else request.pipe(upstream);
}

async function proxyChat(request, response, url, cors) {
  const session = requireSession(request);
  if (session.user.role !== 'owner') fail(403, 'Чат доступен только владельцу');
  if (request.method !== 'GET') requireCsrf(request, session);
  if (!CHAT_API_KEY) fail(503, 'Прокси чата не настроен');

  const chatPath = url.pathname.slice('/content/hugh'.length) || '/';
  const target = new URL(`${CHAT_URL}${chatPath}${url.search}`);
  const headers = { ...request.headers, host: target.host, 'x-api-key': CHAT_API_KEY };
  delete headers.cookie;
  delete headers.origin;
  delete headers.referer;
  const upstream = http.request(target, { method: request.method, headers }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers, ...cors };
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    console.error('content: ошибка прокси чата:', error);
    if (!response.headersSent) send(response, 502, { error: 'Чат недоступен' }, cors);
    else response.destroy(error);
  });
  request.pipe(upstream);
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

    // Локальный обработчик Хью: свой ключ, проверка до чтения тела, только известные маршруты.
    if (url.pathname.startsWith('/content/project-chat-worker/')) {
      await projectChat.localWorker.handle(request, response, url);
      return;
    }
    // Вход в чат проекта из Telegram Mini App: без cookie кабинета, по подписи Telegram.
    if (url.pathname === '/content/project-chat-miniapp/session') {
      await projectChat.miniApp.handle(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/content/internal/project-chat/')) {
      const supplied = String(request.headers['x-api-key'] || '');
      if (!CHAT_API_KEY || Buffer.byteLength(supplied) !== Buffer.byteLength(CHAT_API_KEY) ||
          !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(CHAT_API_KEY))) fail(401,'Нет доступа');
      const route = url.pathname.slice('/content/internal/project-chat'.length);
      if (route === '/binding' && request.method === 'GET') {
        return reply(200,{room:projectChat.bridge.getBinding(url.searchParams.get('chatId'))});
      }
      if (route === '/outbox' && request.method === 'GET') return reply(200,{jobs:projectChat.bridge.pendingTelegram()});
      if (route === '/attachment' && request.method === 'GET') {
        const file = projectChat.bridge.readAttachment(url.searchParams.get('id'),url.searchParams.get('companyCode'));
        return reply(200,{name:file.name,mime:file.mime,base64:file.bytes.toString('base64')});
      }
      if (route === '/migrate' && request.method === 'POST') {
        const body=await readJson(request);
        return reply(200,projectChat.bridge.migrateBinding({chatId:body.chatId,newChatId:body.newChatId}));
      }
      if (route === '/receive' && request.method === 'POST') {
        let body;
        try { body=JSON.parse((await readRaw(request,12*1024*1024)).toString('utf8')); } catch { fail(400,'Некорректное событие'); }
        const chatId=String(body.chatId || ''), messageId=String(body.messageId || '');
        if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(messageId)) fail(400,'Некорректное событие');
        const incoming=body.files || [];
        if(!Array.isArray(incoming) || incoming.length>1) fail(400,'Слишком много вложений');
        // Квитанция, вложения и сообщение сохраняются одной транзакцией внутри модуля комнаты.
        const files=incoming.map(file=>{
          if(typeof file.base64!=='string' || file.base64.length>11200000) fail(413,'Файл слишком большой');
          return {name:file.name,mime:file.mime,bytes:Buffer.from(file.base64,'base64')};
        });
        if (body.command) {
          if (files.length) fail(400,'Команда без вложений');
          return reply(200,await projectChat.bridge.receiveCommand({chatId,messageId,authorId:body.authorId,authorName:body.authorName,text:body.text,command:body.command}));
        }
        return reply(200,projectChat.bridge.receiveTelegram({chatId,messageId,authorId:body.authorId,
          authorName:body.authorName,text:body.text,files,addressed:body.addressed===true}));
      }
      if (route === '/acknowledge' && request.method === 'POST') {
        const body=await readJson(request);
        projectChat.bridge.acknowledgeTelegram(body.jobId,body);
        return reply(200,{ok:true});
      }
      fail(404,'Маршрут не найден');
    }
    if (url.pathname.startsWith('/content/project-chat-runtime/')) {
      const session=requireSession(request);
      if(session.user.role!=='owner') fail(403,'Доступно только владельцу');
      const route=url.pathname.slice('/content/project-chat-runtime'.length);
      if(!((route==='/status' && request.method==='GET') || (route==='/login' && request.method==='POST'))) fail(404,'Маршрут не найден');
      if(request.method==='POST') requireCsrf(request,session);
      // Компания задаёт путь: её локальный обработчик отвечает сам, до проверки общего ключа службы.
      // Сессия, роль и CSRF уже проверены; тело читается только после этого.
      let companyCode='';
      if(request.method==='POST'){
        const raw=(await readRaw(request,4096)).toString('utf8').trim();
        let body={};
        if(raw){ try { body=JSON.parse(raw); } catch { fail(400,'Некорректный JSON'); } }
        companyCode=String(body?.companyCode ?? '');
      } else companyCode=String(url.searchParams.get('companyCode') ?? '');
      if(companyCode && !/^[a-z0-9_-]{1,40}$/.test(companyCode)) fail(400,'Некорректный код компании');
      if(companyCode && projectChat.localWorker.isLocal(companyCode)){
        if(route==='/status') return reply(200,projectChat.localWorker.ownerStatus(companyCode),{'cache-control':'no-store'});
        const login=projectChat.localWorker.requestLogin(companyCode);
        return reply(login.accepted?202:200,login.status,{'cache-control':'no-store'});
      }
      if(!CHAT_API_KEY) return reply(503,{state:'unconfigured',connected:false,configured:false,provider:'codex',
        error:'Служба Хью не настроена'},{'cache-control':'no-store'});
      try {
        // /login внутри рантайма ждёт ответ account/login/start до 30 с. Прокси обязан пережить
        // это ожидание, иначе владелец видит сетевую ошибку вместо выданных ссылки и кода.
        // Быстрый /status остаётся на прежней границе: он не должен держать вкладку.
        const upstream=await fetch(`${HUGH_RUNTIME_URL}${route}`,{method:request.method,
          headers:{'content-type':'application/json','x-api-key':CHAT_API_KEY,authorization:`Bearer ${CHAT_API_KEY}`},
          ...(request.method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(route==='/login'?35000:12000)});
        // Наружу отдаём только известные поля: чужой ответ по этому адресу не станет эхом в кабинете.
        return reply(upstream.status,sanitizeRuntime(await upstream.json().catch(()=>null)),{'cache-control':'no-store'});
      } catch { return reply(503,{state:'unavailable',connected:false,configured:true,provider:'codex',
        error:'Подключение Хью пока недоступно'},{'cache-control':'no-store'}); }
    }
    if (await projectChat.handle(request,response,url)) return;

    if (url.pathname === '/content/crm' || url.pathname.startsWith('/content/crm/')) {
      return await proxyCrm(request, response, url, cors);
    }
    if (url.pathname === '/content/admin/hugh-settings') {
      const session = requireSession(request);
      if (session.user.role !== 'owner') fail(403, 'Доступно только владельцу');
      if (request.method === 'GET') return reply(200, hughSettingsStore.get());
      if (request.method === 'PUT') {
        requireCsrf(request, session);
        const body = await readJson(request);
        if (Object.keys(body).join(',') !== 'settings') fail(400, 'Переданы лишние поля');
        return reply(200, hughSettingsStore.save(body.settings, session.user.id));
      }
      fail(405, 'Метод не поддерживается');
    }
    if (url.pathname === '/content/hugh' || url.pathname.startsWith('/content/hugh/')) {
      return await proxyChat(request, response, url, cors);
    }

    if (request.method === 'POST' && url.pathname === '/content/login') {
      const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '').split(',')[0].trim();
      const now = Date.now();
      const failures = (loginFailures.get(ip) || []).filter((time) => now - time < LOGIN_WINDOW);
      if (failures.length >= LOGIN_LIMIT) fail(429, 'Слишком много попыток, подождите 10 минут');
      const body = await readJson(request);
      const login = String(body.login || '').trim().toLowerCase();
      const identity = authStore.getByLogin(login);
      if (!identity || !verifyPassword(String(body.password || ''), identity.passwordHash)) {
        failures.push(now); loginFailures.set(ip, failures);
        const error = new Error('Неверный логин или пароль');
        error.status = 401;
        error.login = login || 'неизвестен';
        throw error;
      }
      loginFailures.delete(ip);
      return reply(200, publicIdentity(identity), { 'set-cookie': `synapse_session=${makeSession(identity)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}` });
    }
    if (request.method === 'POST' && url.pathname === '/content/logout') {
      return reply(200, { ok: true }, { 'set-cookie': 'synapse_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (request.method === 'GET' && url.pathname === '/content/whoami') {
      const session = requireSession(request);
      return reply(200, { ...publicIdentity(session.user), csrfToken: session.csrf });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return reply(200, { ok: true, service: 'content' });
    }

    /* Настройка провайдеров Хью: только владелец, только с CSRF на запись.
       Ключ уходит на сервер и обратно никогда не возвращается. */
    if (url.pathname === '/content/hugh-providers' || /^\/content\/hugh-providers\/[a-z0-9-]{1,32}(?:\/check)?$/.test(url.pathname)) {
      const session = requireSession(request);
      if (session.user.role !== 'owner') fail(403, 'Настройка провайдеров доступна владельцу');
      const match = /^\/content\/hugh-providers\/([a-z0-9-]{1,32})(\/check)?$/.exec(url.pathname);
      if (url.pathname === '/content/hugh-providers' && request.method === 'GET') return reply(200, hughProviders.status());
      if (match && !match[2] && request.method === 'PUT') {
        requireCsrf(request, session);
        return reply(200, hughProviders.save(match[1], await readJson(request), session.user));
      }
      if (match && match[2] && request.method === 'POST') {
        requireCsrf(request, session);
        // Проверка соединения — явное отдельное действие владельца, а не следствие сохранения.
        return reply(200, await hughProviders.check(match[1]));
      }
      fail(405, 'Метод не поддерживается');
    }
    if (url.pathname === '/content/publishing-assets') {
      if (request.method !== 'POST') fail(405, 'Метод не поддерживается');
      const session = requireSession(request), code = url.searchParams.get('companyCode');
      if (!code || !Object.hasOwn(COMPANIES, code)) fail(400, 'Выберите компанию');
      if (session.user.role !== 'owner') {
        if (!session.user.companyCodes.includes(code)) fail(403, 'Нет доступа к компании');
        if (!['autoposting.edit','company-information.edit'].some(permission=>session.user.permissions.includes(permission))) fail(403, 'Недостаточно прав');
      }
      requireCsrf(request, session);
      const type = String(request.headers['content-type'] || '').split(';')[0].trim();
      if (!Object.hasOwn(ASSET_TYPES,type)) fail(415, 'Допустимы фотографии JPEG, PNG, WebP и видео MP4, WebM');
      const video = VIDEO_TYPES.has(type);
      const bytes = await readRaw(request, video ? MAX_PUBLISHING_VIDEO : MAX_PUBLISHING_ASSET);
      const valid = type === 'image/jpeg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
        type === 'image/png' ? bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
        type === 'image/webp' ? bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' :
        type === 'video/mp4' ? bytes.length >= 12 && bytes.toString('ascii',4,8) === 'ftyp' :
          bytes.length >= 4 && bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
      if (!valid) fail(415, video ? 'Файл не соответствует выбранному формату видео' : 'Файл не соответствует выбранному формату фотографии');
      const name = crypto.randomBytes(16).toString('hex') + ASSET_TYPES[type];
      const directory = path.join(ASSETS_DIR,'publishing',code);
      fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(path.join(directory,name),bytes,{flag:'wx'});
      // Хеш нужен, чтобы сверить загруженный ролик с пакетом материалов, а не принять заглушку за готовое видео.
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      return reply(201,{url:`${PUBLISHING_ASSET_ORIGIN}/content/publishing-assets/${code}/${name}`,size:bytes.length,type,sha256});
    }
    if (url.pathname.startsWith('/content/publishing-assets/')) {
      if (!['GET','HEAD'].includes(request.method)) fail(405, 'Метод не поддерживается');
      const match = /^\/content\/publishing-assets\/([a-z0-9_-]{1,64})\/([a-f0-9]{32}\.(jpg|png|webp|mp4|webm))$/.exec(url.pathname);
      if (!match || !Object.hasOwn(COMPANIES,match[1])) fail(404,'Материал не найден');
      const file = path.join(ASSETS_DIR,'publishing',match[1],match[2]);
      if (!fs.existsSync(file)) fail(404,'Материал не найден');
      const size = fs.statSync(file).size;
      const headers = {'content-type':ASSET_MIME[match[3]],'cache-control':'public, max-age=31536000, immutable','accept-ranges':'bytes',
        'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'content-disposition':`inline; filename="${match[2]}"`};
      // Диапазоны нужны плееру: без них перемотка и предпросмотр видео в браузере не работают.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
      let start = 0, end = size - 1, status = 200;
      if (range && VIDEO_TYPES.has(headers['content-type'])) {
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
        end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          response.writeHead(416, {'content-range':`bytes */${size}`}); return response.end();
        }
        status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['content-length'] = end - start + 1;
      response.writeHead(status, headers);
      if (request.method === 'HEAD') return response.end();
      const stream = fs.createReadStream(file, {start, end}); stream.on('error',()=>response.destroy());
      response.on('close',()=>stream.destroy()); return stream.pipe(response);
    }

    const ownerDocumentKey = parts.length === 3 ? `${parts[1]}/${parts[2]}` : null;
    if (ownerDocumentKey && OWNER_DOCUMENTS.has(ownerDocumentKey)) {
      const session = requireSession(request);
      if (session.user.role !== 'owner') fail(403, 'Доступно только владельцу');
      if (request.method === 'GET') {
        const row = latestStmt.get(ownerDocumentKey);
        if (!row) fail(404, `Документ ${ownerDocumentKey} не найден`);
        return reply(200, row.body, { etag: `"${row.version}"` });
      }
      if (request.method === 'PUT') {
        requireCsrf(request, session);
        const document = await readJson(request);
        OWNER_DOCUMENTS.get(ownerDocumentKey)(document);
        return reply(200, { ok: true, key: ownerDocumentKey,
          ...saveVersion(ownerDocumentKey, document, publicIdentity(session.user).author) });
      }
      fail(405, 'Метод не поддерживается');
    }

    if (url.pathname === '/content/admin/accounts' || url.pathname.startsWith('/content/admin/accounts/')) {
      const session = requireSession(request);
      if (session.user.role !== 'owner' && !session.user.permissions.includes('account.view')) fail(403, 'Недостаточно прав');
      if (request.method !== 'GET') requireCsrf(request, session);
      if (request.method === 'GET' && parts[3] === 'access-options' && parts.length === 4) {
        return reply(200, { companies: Object.entries(COMPANIES).map(([id, company]) => ({ id, ...company })),
          permissions: PERMISSIONS, dependencies: DEPENDENCIES, presets: [PRICE_CLIENT_PRESET] });
      }
      const id = Number(parts[3]);
      if (request.method === 'GET' && parts.length === 3) {
        return reply(200, { accounts: authStore.list().map(authStore.public) });
      }
      if (request.method === 'POST' && parts.length === 3) {
        const body = await readJson(request);
        const account = authStore.create(session.user.id, body, hashPassword(body.password));
        return reply(201, authStore.public(account));
      }
      if (request.method === 'PATCH' && parts.length === 4) {
        if (session.user.role !== 'owner') fail(403, 'Изменять учётные записи может только администратор');
        const before = authStore.getById(id);
        const updated = authStore.updateAccount(session.user.id, id, await readJson(request));
        logAccountMutation('changed', session.user, before, updated);
        return reply(200, authStore.public(updated));
      }
      if (request.method === 'DELETE' && parts.length === 4) {
        if (session.user.role !== 'owner') fail(403, 'Удалять учётные записи может только администратор');
        const before = authStore.getById(id);
        const removed = authStore.remove(session.user.id, id);
        logAccountMutation('deleted', session.user, before, null);
        return reply(200, { ok: true, account: authStore.public(removed) });
      }
      if (request.method === 'PUT' && parts[4] === 'password' && parts.length === 5) {
        const body = await readJson(request);
        if (Object.keys(body).join(',') !== 'password') fail(400, 'Переданы лишние поля');
        return reply(200, authStore.public(authStore.updatePassword(session.user.id, id,
          hashPassword(body.password))));
      }
      if (request.method === 'PUT' && parts[4] === 'access' && parts.length === 5) {
        const body = await readJson(request);
        if (Object.keys(body).sort().join(',') !== 'companies,permissions') fail(400, 'Переданы лишние поля');
        return reply(200, authStore.public(authStore.updateAccess(session.user.id, id,
          body.companies, body.permissions)));
      }
      fail(404, 'Пользователь не найден');
    }

    if (url.pathname === '/content/sites' || url.pathname.startsWith('/content/sites/')) {
      const id = parts[2] ? decodeURIComponent(parts[2]) : null;
      if (request.method === 'GET' && id && parts[3] === 'document') {
        const session = requirePermission(request, 'site_editor.view');
        const site = siteStore.get(session.user, id);
        const row = latestStmt.get(`${id}/site`);
        if (!row) fail(404, 'Документ не найден');
        return reply(200, { site, document: JSON.parse(row.body) });
      }
      const permission = request.method === 'POST' ? 'sites.create'
        : request.method === 'DELETE' ? 'sites.delete' : 'sites.view';
      const session = requirePermission(request, permission);
      if (request.method !== 'GET') requireCsrf(request, session);
      if (request.method === 'GET' && !id) {
        return reply(200, { sites: siteStore.list(session.user, {
          companyCode: url.searchParams.get('companyCode'), state: url.searchParams.get('state'),
        }) });
      }
      if (request.method === 'GET' && id) return reply(200, siteStore.get(session.user, id));
      if (request.method === 'POST' && !id) {
        const body = await readJson(request);
        if (Object.keys(body).sort().join(',') !== 'companyCode,name') fail(400, 'Переданы лишние поля');
        const created = siteStore.create(session.user, body);
        return reply(201, { ...created, editorUrl: created.editorUrls.site });
      }
      if (request.method === 'DELETE' && id) {
        siteStore.remove(session.user, id);
        return reply(200, { ok: true });
      }
      fail(404, 'Не найдено');
    }

    // Capability link for recipients: no browser session or private CRM fields are forwarded.
    if (parts[0] === 'public-email-unsubscribe') {
      let result;
      try {
        if (parts.length !== 2 || !EMAIL_UNSUBSCRIBE_TOKEN.test(parts[1]) || !['GET', 'POST'].includes(request.method)) fail(404, 'Ссылка не найдена');
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024) fail(413, 'Слишком большой запрос');
          chunks.push(chunk);
        }
        result = await publicEmailUnsubscribe({token: parts[1], method: request.method, body: Buffer.concat(chunks).toString('utf8')});
      } catch (error) {
        const status = [404, 413, 502, 503].includes(error.status) ? error.status : 502;
        const message = status === 404 ? 'Ссылка отписки не найдена или недействительна.'
          : status === 413 ? 'Не удалось обработать запрос. Откройте ссылку из письма ещё раз.'
            : 'Отписка временно недоступна. Попробуйте позже.';
        result = {status, html: `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отписка</title><main><h1>Отписка от рассылки</h1><p>${message}</p></main></html>`};
      }
      response.writeHead(result.status, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      return response.end(result.html);
    }

    // A site's Caddy route selects its company; client query parameters cannot change it.
    if (parts[0] === 'public-company-links') {
      if (request.method !== 'GET' || parts.length !== 2 || !SITES.has(parts[1])) fail(404, 'Не найдено');
      return reply(200, await readCompanyLinks(parts[1]), {'cache-control': 'no-store'});
    }

    // Only the public-site Caddy handlers rewrite to this GET-only route.
    // The cabinet proxies /content/*, never /public-content/*.
    if (parts[0] === 'public-content') {
      if (request.method !== 'GET' || parts.length !== 3 || !SITES.has(parts[1]) || !Object.hasOwn(DOCUMENT_VALIDATORS, parts[2])) {
        fail(404, 'Не найдено');
      }
      const row = latestStmt.get(`${parts[1]}/${parts[2]}`);
      if (!row) fail(404, 'Документ не найден');
      return reply(200, row.body, { etag: `"${row.version}"` });
    }

    // Заявка с сайта: только Caddy-маршрут Palitra переписывает сюда POST /api/orders. Без cookie и ключей.
    if (parts[0] === 'public-orders') {
      if (request.method !== 'POST' || parts.length !== 2 || !Object.hasOwn(ORDER_SITES, parts[1])) fail(404, 'Не найдено');
      if (!/^application\/json\b/i.test(String(request.headers['content-type'] || ''))) fail(415, 'Ожидался JSON');
      let body;
      try { body = JSON.parse((await readRaw(request, ORDER_BODY_LIMIT)).toString('utf8')); } catch (error) { if (error.status === 413) throw error; fail(400, 'Некорректный JSON'); }
      try {
        const result = projectChat.siteOrders.submit({ site: parts[1], body, origin: originOf(request), ip: clientIp(request) });
        return reply(result.status, result.body, { 'cache-control': 'no-store' });
      } catch (error) {
        if (![400, 403, 409, 429, 503].includes(error.status)) throw error;
        return reply(error.status, { ok: false, code: error.code || 'VALIDATION', error: error.message, ...(error.itemId ? { itemId: error.itemId } : {}) },
          { 'cache-control': 'no-store', ...(error.status === 429 ? { 'retry-after': '600' } : {}) });
      }
    }

    if (parts[0] !== 'content' || parts.length < 3) fail(404, 'Не найдено');
    if (!SITES.has(parts[1])) fail(404, 'Неизвестный сайт');

    // --- заявки с сайта в ЛК: только владелец, только сайт Palitra; мутации с CSRF.
    if (parts[2] === 'orders' || parts[2] === 'order-recipient') {
      const session = requireSession(request);
      if (session.user.role !== 'owner') fail(403, 'Доступно только владельцу');
      if (request.method !== 'GET') requireCsrf(request, session);
      const orders = projectChat.siteOrders, site = parts[1];
      const headers = { 'cache-control': 'no-store' };
      if (parts[2] === 'orders' && parts.length === 3 && request.method === 'GET') {
        return reply(200, orders.listOrders(site, { limit: url.searchParams.get('limit'), beforeId: url.searchParams.get('beforeId') }), headers);
      }
      if (parts[2] === 'orders' && parts.length === 5 && parts[4] === 'renotify' && request.method === 'POST') return reply(202, orders.renotify(site, parts[3]), headers);
      if (parts[2] === 'order-recipient' && parts.length === 3 && request.method === 'GET') return reply(200, orders.recipientStatus(site), headers);
      if (parts[2] === 'order-recipient' && parts.length === 3 && request.method === 'PUT') return reply(200, orders.setRecipient(site, await readJson(request)), headers);
      if (parts[2] === 'order-recipient' && parts.length === 4 && parts[3] === 'test' && request.method === 'POST') return reply(202, orders.testRecipient(site), headers);
      fail(404, 'Не найдено');
    }

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
        const permission = sessionData(request)?.user.permissions.includes('price.view') ? 'price.view' : 'site_editor.view';
        requireContentAccess(request, permission, site);
        const list = fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => ({ name: n, url: `/api/assets/${n}`, size: fs.statSync(path.join(dir, n)).size })) : [];
        return reply(200, { site, files: list });
      }
      if (request.method === 'POST' && parts.length === 3) {
        // Price editors can upload product photos without receiving site-editor permissions.
        const permission = sessionData(request)?.user.permissions.includes('price.edit') ? 'price.edit' : 'site_editor.edit';
        const author = requireContentAccess(request, permission, site, true).author;
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

    // GET /content/:site/:doc — документ кабинета проверяет проект и право просмотра
    if (request.method === 'GET' && tail.length === 0) {
      requireContentAccess(request, parts[2] === 'price' ? 'price.view' : 'site_editor.view', parts[1]);
      const row = latestStmt.get(key);
      if (!row) fail(404, `Документ ${key} не найден`);
      return reply(200, row.body, { etag: `"${row.version}"` });
    }

    // GET /content/:site/:doc/history
    if (request.method === 'GET' && tail[0] === 'history' && tail.length === 1) {
      requireContentAccess(request, parts[2] === 'price' ? 'price.view' : 'site_editor.view', parts[1]);
      return reply(200, { key, versions: historyStmt.all(key, HISTORY_LIMIT) });
    }

    // GET /content/:site/:doc/version/:n
    if (request.method === 'GET' && tail[0] === 'version' && tail.length === 2) {
      requireContentAccess(request, parts[2] === 'price' ? 'price.view' : 'site_editor.view', parts[1]);
      const row = byVersionStmt.get(key, Number.parseInt(tail[1], 10));
      if (!row) fail(404, 'Версия не найдена');
      return reply(200, row.body);
    }

    // PUT /content/:site/:doc — новая версия (по ключу)
    if (request.method === 'PUT' && tail.length === 0) {
      const author = requireContentAccess(request,
        parts[2] === 'price' ? 'price.edit' : 'site_editor.edit', parts[1], true).author;
      const doc = await readJson(request);
      const validator = DOCUMENT_VALIDATORS[parts[2]];
      if (!validator) fail(404, 'Неизвестный тип документа');
      validator(doc);
      const saved = saveVersion(key, doc, author);
      return reply(200, { ok: true, key, ...saved });
    }

    // POST /content/:site/:doc/restore/:n — откат (по ключу)
    if (request.method === 'POST' && tail[0] === 'restore' && tail.length === 2) {
      const author = requireContentAccess(request,
        parts[2] === 'price' ? 'price.edit' : 'site_editor.edit', parts[1], true).author;
      const row = byVersionStmt.get(key, Number.parseInt(tail[1], 10));
      if (!row) fail(404, 'Версия не найдена');
      const saved = saveVersion(key, JSON.parse(row.body), `${author} (откат к ${row.version})`);
      return reply(200, { ok: true, key, restoredFrom: row.version, ...saved });
    }

    fail(404, 'Не найдено');
  } catch (error) {
    const status = error.status || 500;
    if (status === 401 || status === 403) logAuthorizationDenial(request, error);
    if (status >= 500) console.error(error);
    reply(status, { error: error.message, details: error.details || undefined });
  }
});

server.listen(PORT, () => {
  console.log(`content: слушает порт ${PORT}, база ${DATABASE_PATH}`);
  projectChat.startWorker();
});

function shutdownContent() {
  projectChat.stopWorker();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdownContent);
process.on('SIGINT', shutdownContent);
