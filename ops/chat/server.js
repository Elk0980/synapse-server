'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

// Тексты сценария собраны здесь, чтобы их можно было менять без поиска по коду.
const SCRIPT = {
  greeting: 'Здравствуйте! Я Хью, ассистент Synapse Business. Как я могу к вам обращаться и какой у вас вопрос?',
  askName: 'Спасибо! Подскажите, пожалуйста, как к вам обращаться?',
  askPhone: 'Чтобы специалист мог точно ответить, оставьте, пожалуйста, номер телефона.',
  askQuestion: 'Спасибо! Опишите, пожалуйста, ваш вопрос — я передам его специалисту.',
  accepted: 'Спасибо! Я передал вопрос специалисту. Он свяжется с вами по указанному номеру.',
  unknown: 'Я не буду придумывать цены или обещания: на этот вопрос точно ответит специалист. Оставьте, пожалуйста, номер телефона для связи.',
};

const MODEL_SYSTEM_PROMPT = `Ты — русскоязычный ассистент Synapse Business. Отвечай кратко и доброжелательно. Твоя цель — узнать вопрос посетителя, его имя и номер телефона. Никогда не выдумывай цены, сроки, гарантии или обещания. Если точного ответа нет, честно скажи, что ответит специалист, и попроси номер телефона. Не утверждай, что заявка создана, если система этого не сообщала.`;

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/chat.sqlite';
const API_KEY = process.env.API_KEY || '';
const CRM_URL = process.env.CRM_URL || '';
const CRM_API_KEY = process.env.CRM_API_KEY || '';
const MODEL_API_URL = process.env.MODEL_API_URL || '';
const MODEL_API_KEY = process.env.MODEL_API_KEY || '';
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

if (!API_KEY.trim()) throw new Error('API_KEY не должен быть пустым');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535');

const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    site TEXT,
    page TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    referrer TEXT,
    client_id TEXT,
    visitor_key TEXT NOT NULL,
    lead_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('visitor', 'assistant', 'operator')),
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at);
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, id);
`);

const insertConversation = db.prepare(`INSERT INTO conversations
  (created_at, updated_at, site, page, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, client_id, visitor_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const getConversation = db.prepare('SELECT * FROM conversations WHERE id = ?');
const insertMessage = db.prepare('INSERT INTO messages (conversation_id, created_at, role, text) VALUES (?, ?, ?, ?)');
const getMessages = db.prepare('SELECT id, created_at, role, text FROM messages WHERE conversation_id = ? ORDER BY id');
const touchConversation = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
const saveLead = db.prepare("UPDATE conversations SET lead_id = ?, status = 'lead', updated_at = ? WHERE id = ?");
const visitorLimits = new Map();
const ipLimits = new Map();

function send(response, status, payload, origin) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  });
  response.end(body);
}

function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(400, `Поле «${field}» должно быть строкой`);
  return value.trim().slice(0, 4000) || null;
}
async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) fail(413, 'Тело запроса не должно превышать 1 МБ'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, 'Тело запроса должно быть JSON-объектом'); return value; }
  catch (error) { if (error.status) throw error; fail(400, 'Некорректный JSON'); }
}
function conversationId(value) { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный идентификатор диалога'); return id; }
function existingConversation(id) { const row = getConversation.get(id); if (!row) fail(404, 'Диалог не найден'); return row; }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function requireVisitor(request, row) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') || request.headers['x-visitor-token'];
  if (!token || hashToken(String(token)) !== row.visitor_key) fail(401, 'Неверный токен посетителя');
}
function requireOperator(request) { if (request.headers['x-api-key'] !== API_KEY) fail(401, 'Неверный API-ключ'); }
function clientIp(request) { return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '').split(',')[0].trim(); }
function takeLimit(map, key, maximum, windowMs) {
  const now = Date.now(); const recent = (map.get(key) || []).filter(time => time > now - windowMs);
  if (recent.length >= maximum) fail(429, 'Слишком много сообщений. Попробуйте позже.');
  recent.push(now); map.set(key, recent);
}
function serialize(row) {
  return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, site: row.site, page: row.page,
    utmSource: row.utm_source, utmMedium: row.utm_medium, utmCampaign: row.utm_campaign,
    utmTerm: row.utm_term, utmContent: row.utm_content, referrer: row.referrer,
    clientId: row.client_id, leadId: row.lead_id, status: row.status, messages: getMessages.all(row.id) };
}
function contactData(messages) {
  const texts = messages.filter(item => item.role === 'visitor').map(item => item.text);
  const joined = texts.join('\n');
  const phone = joined.match(/(?:\+?7|8)?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/)?.[0]?.trim() || null;
  const explicit = joined.match(/(?:меня зовут|я)\s+([А-ЯЁ][а-яё-]{1,30})/i)?.[1];
  const shortName = texts.find(text => /^[А-ЯЁ][а-яё-]{1,30}$/i.test(text.trim()))?.trim();
  const firstQuestion = texts.find(text => text !== shortName && text !== phone && !/^(?:меня зовут|я)\s+[А-ЯЁ][а-яё-]{1,30}[.!]?$/i.test(text.trim())) || null;
  return { name: explicit || shortName || null, phone, firstQuestion };
}
async function createLead(row, data) {
  if (!CRM_URL || !CRM_API_KEY) { console.error('CRM_URL или CRM_API_KEY не настроены: заявка не создана'); return false; }
  const payload = { name: data.name, contact: data.phone, channel: 'chat',
    utmSource: row.utm_source, utmMedium: row.utm_medium, utmCampaign: row.utm_campaign,
    utmContent: row.utm_content, clientId: row.client_id, referrer: row.referrer,
    landingPage: row.page, source: row.utm_source, firstQuestion: data.firstQuestion };
  const response = await fetch(CRM_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': CRM_API_KEY }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`CRM вернула HTTP ${response.status}`);
  const lead = await response.json();
  if (!lead.id) throw new Error('CRM не вернула id заявки');
  saveLead.run(lead.id, new Date().toISOString(), row.id); return true;
}
function scriptedReply(data, leadCreated) {
  if (leadCreated) return SCRIPT.accepted;
  if (!data.name) return SCRIPT.askName;
  if (!data.phone) return SCRIPT.askPhone;
  if (!data.firstQuestion) return SCRIPT.askQuestion;
  return SCRIPT.unknown;
}
async function modelReply(messages) {
  const response = await fetch(MODEL_API_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${MODEL_API_KEY}` },
    body: JSON.stringify({ messages: [{ role: 'system', content: MODEL_SYSTEM_PROMPT }, ...messages.map(item => ({ role: item.role === 'visitor' ? 'user' : 'assistant', content: item.text }))] }) });
  if (!response.ok) throw new Error(`Модель вернула HTTP ${response.status}`);
  const body = await response.json(); const text = body.choices?.[0]?.message?.content || body.reply || body.output;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Модель вернула пустой ответ');
  return text.trim();
}

async function route(request, response, origin) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/conversations') {
    const body = await readJson(request); const token = crypto.randomBytes(32).toString('base64url'); const now = new Date().toISOString();
    const values = [now, now, optionalString(body.site, 'site'), optionalString(body.page, 'page'), ...UTM_FIELDS.map(field => optionalString(body[field] ?? body[field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())], field)), optionalString(body.referrer, 'referrer'), optionalString(body.client_id ?? body.clientId, 'client_id'), hashToken(token)];
    const result = insertConversation.run(...values); const id = Number(result.lastInsertRowid);
    insertMessage.run(id, now, 'assistant', SCRIPT.greeting);
    return send(response, 201, { id, visitorToken: token, reply: SCRIPT.greeting }, origin);
  }
  if (request.method === 'GET' && url.pathname === '/conversations') {
    requireOperator(request); const rows = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 500').all();
    return send(response, 200, { conversations: rows.map(serialize) }, origin);
  }
  let match = url.pathname.match(/^\/conversations\/(\d+)$/);
  if (request.method === 'GET' && match) { const row = existingConversation(conversationId(match[1])); if (request.headers['x-api-key'] !== API_KEY) requireVisitor(request, row); return send(response, 200, serialize(row), origin); }
  match = url.pathname.match(/^\/conversations\/(\d+)\/messages$/);
  if (request.method === 'POST' && match) {
    const row = existingConversation(conversationId(match[1])); requireVisitor(request, row);
    takeLimit(visitorLimits, row.id, 20, 60 * 1000); takeLimit(ipLimits, clientIp(request), 60, 60 * 60 * 1000);
    const body = await readJson(request); const text = optionalString(body.text, 'text'); if (!text) fail(400, 'Поле «text» обязательно');
    let now = new Date().toISOString(); insertMessage.run(row.id, now, 'visitor', text); touchConversation.run(now, row.id);
    const all = getMessages.all(row.id); const data = contactData(all); let leadCreated = false;
    if (!row.lead_id && data.name && data.phone && data.firstQuestion) { try { leadCreated = await createLead(row, data); } catch (error) { console.error('Не удалось создать заявку в CRM:', error); } }
    let reply = scriptedReply(data, leadCreated);
    if (MODEL_API_URL && MODEL_API_KEY && !leadCreated) { try { reply = await modelReply(all); } catch (error) { console.error('Ошибка модели, используется сценарий:', error); } }
    now = new Date().toISOString(); insertMessage.run(row.id, now, 'assistant', reply); touchConversation.run(now, row.id);
    return send(response, 201, { reply, conversation: serialize(getConversation.get(row.id)) }, origin);
  }
  match = url.pathname.match(/^\/conversations\/(\d+)\/operator$/);
  if (request.method === 'POST' && match) { requireOperator(request); const row = existingConversation(conversationId(match[1])); const body = await readJson(request); const text = optionalString(body.text, 'text'); if (!text) fail(400, 'Поле «text» обязательно'); const now = new Date().toISOString(); insertMessage.run(row.id, now, 'operator', text); touchConversation.run(now, row.id); return send(response, 201, serialize(getConversation.get(row.id)), origin); }
  fail(404, 'Метод или адрес не найден');
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return send(response, 403, { error: 'Источник запроса не разрешён' });
  if (request.method === 'OPTIONS') { response.writeHead(204, { ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}), 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, X-Visitor-Token, X-API-Key', 'access-control-max-age': '86400' }); return response.end(); }
  route(request, response, origin).catch(error => { console.error(error); send(response, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервиса' }, origin); });
});
server.listen(PORT, () => console.log(`Чат слушает порт ${PORT}; база: ${DATABASE_PATH}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
