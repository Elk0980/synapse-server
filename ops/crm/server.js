'use strict';

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/crm.sqlite';
const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)
);
const STAGES = ['новая', 'в работе', 'записан', 'пришёл', 'продажа', 'отказ'];
const STAGE_RANK = new Map(STAGES.map((stage, index) => [stage, index]));
const leadAttempts = new Map();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535');
}
if (!API_KEY) throw new Error('Переменная окружения API_KEY обязательна и не должна быть пустой');

const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    channel TEXT,
    source TEXT,
    tag TEXT,
    page TEXT,
    first_question TEXT,
    stage TEXT NOT NULL DEFAULT 'новая'
      CHECK (stage IN ('новая', 'в работе', 'записан', 'пришёл', 'продажа', 'отказ')),
    sale_amount REAL CHECK (sale_amount IS NULL OR sale_amount >= 0),
    sold_at TEXT,
    comment TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    referrer TEXT,
    landing_page TEXT,
    client_id TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    spent_on TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0)
  );
`);

const leadColumns = new Set(db.prepare('PRAGMA table_info(leads)').all().map((column) => column.name));
const migrations = {
  utm_source: 'TEXT', utm_medium: 'TEXT', utm_campaign: 'TEXT', utm_content: 'TEXT',
  referrer: 'TEXT', landing_page: 'TEXT', client_id: 'TEXT', updated_at: 'TEXT',
};
for (const [column, type] of Object.entries(migrations)) {
  if (!leadColumns.has(column)) db.exec(`ALTER TABLE leads ADD COLUMN ${column} ${type}`);
}
db.exec(`
  UPDATE leads SET updated_at = created_at WHERE updated_at IS NULL;
  CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads(stage);
  CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source);
  CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at);
  CREATE INDEX IF NOT EXISTS leads_contact_idx ON leads(contact);
  CREATE INDEX IF NOT EXISTS messages_lead_id_idx ON messages(lead_id);
  CREATE INDEX IF NOT EXISTS stage_history_lead_id_idx ON stage_history(lead_id);
  CREATE INDEX IF NOT EXISTS costs_source_spent_on_idx ON costs(source, spent_on);
`);

const createLead = db.prepare(`
  INSERT INTO leads (created_at, updated_at, name, contact, channel, source, tag, page,
    first_question, stage, comment, utm_source, utm_medium, utm_campaign, utm_content,
    referrer, landing_page, client_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'новая', ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getLead = db.prepare('SELECT * FROM leads WHERE id = ?');
const getLeadByContact = db.prepare('SELECT * FROM leads WHERE contact = ? ORDER BY id LIMIT 1');
const getMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const getMessages = db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at, id');
const getHistory = db.prepare('SELECT * FROM stage_history WHERE lead_id = ? ORDER BY changed_at, id');
const insertMessage = db.prepare('INSERT INTO messages (lead_id, created_at, author, text) VALUES (?, ?, ?, ?)');
const insertHistory = db.prepare('INSERT INTO stage_history (lead_id, from_stage, to_stage, changed_at) VALUES (?, ?, ?, ?)');
const updateStage = db.prepare('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?');
const updateSale = db.prepare("UPDATE leads SET stage = 'продажа', sale_amount = ?, sold_at = ?, updated_at = ? WHERE id = ?");

function send(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

function fail(status, message, details) {
  const error = new Error(message); error.status = status; error.details = details; throw error;
}

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) fail(413, 'Тело запроса не должно превышать 1 МБ');
    chunks.push(chunk);
  }
  if (!chunks.length) fail(400, 'Ожидалось тело запроса в формате JSON');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, 'Тело запроса должно быть JSON-объектом');
    return value;
  } catch (error) { if (error.status) throw error; fail(400, 'Некорректный JSON'); }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `Поле «${field}» обязательно и должно быть непустой строкой`);
  return value.trim();
}
function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(400, `Поле «${field}» должно быть строкой`);
  return value.trim() || null;
}
function leadId(value) {
  const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный идентификатор заявки'); return id;
}
function date(value, field, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(400, `Поле «${field}» должно содержать дату в формате ISO 8601`);
  return new Date(value).toISOString();
}

function serializeLead(row) {
  return {
    id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, name: row.name,
    contact: row.contact, channel: row.channel, source: row.source, tag: row.tag,
    page: row.page, firstQuestion: row.first_question, stage: row.stage,
    saleAmount: row.sale_amount, soldAt: row.sold_at, comment: row.comment,
    utmSource: row.utm_source, utmMedium: row.utm_medium, utmCampaign: row.utm_campaign,
    utmContent: row.utm_content, referrer: row.referrer, landingPage: row.landing_page,
    clientId: row.client_id,
  };
}
function serializeMessage(row) { return { id: row.id, leadId: row.lead_id, createdAt: row.created_at, author: row.author, text: row.text }; }
function serializeHistory(row) { return { id: row.id, leadId: row.lead_id, fromStage: row.from_stage, toStage: row.to_stage, changedAt: row.changed_at }; }
function existingLead(id) { const row = getLead.get(id); if (!row) fail(404, 'Заявка не найдена'); return row; }
function requireApiKey(request) { if (request.headers['x-api-key'] !== API_KEY) fail(401, 'Неверный или отсутствующий API-ключ'); }
function corsHeaders(request) {
  const origin = request.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}
function checkRateLimit(request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  const forwardedIp = typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : '';
  const now = Date.now(); const ip = forwardedIp || request.socket.remoteAddress || 'неизвестный';
  const attempts = (leadAttempts.get(ip) || []).filter((time) => now - time < 60000);
  if (attempts.length >= 5) fail(429, 'Превышен лимит: не более 5 заявок в минуту');
  attempts.push(now); leadAttempts.set(ip, attempts);
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'OPTIONS' && url.pathname === '/leads') {
    const headers = corsHeaders(request);
    if (!headers['access-control-allow-origin']) fail(403, 'Источник запроса не разрешён');
    response.writeHead(204, { ...headers, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, X-API-Key', 'access-control-max-age': '600' });
    return response.end();
  }
  if (request.method === 'GET' || request.method === 'PATCH' || (request.method === 'POST' && url.pathname !== '/leads')) requireApiKey(request);

  if (request.method === 'POST' && url.pathname === '/leads') {
    checkRateLimit(request);
    const body = await readJson(request);
    const name = requiredString(body.name, 'name'); const contact = requiredString(body.contact, 'contact');
    const duplicate = getLeadByContact.get(contact);
    if (duplicate) {
      const text = optionalString(body.firstQuestion, 'firstQuestion') || optionalString(body.comment, 'comment') || 'Повторное обращение';
      insertMessage.run(duplicate.id, new Date().toISOString(), name, text);
      return send(response, 200, { ...serializeLead(getLead.get(duplicate.id)), duplicate: true }, corsHeaders(request));
    }
    const now = new Date().toISOString();
    const result = createLead.run(now, now, name, contact,
      optionalString(body.channel, 'channel'), optionalString(body.source, 'source'), optionalString(body.tag, 'tag'),
      optionalString(body.page, 'page'), optionalString(body.firstQuestion, 'firstQuestion'), optionalString(body.comment, 'comment'),
      optionalString(body.utmSource, 'utmSource'), optionalString(body.utmMedium, 'utmMedium'),
      optionalString(body.utmCampaign, 'utmCampaign'), optionalString(body.utmContent, 'utmContent'),
      optionalString(body.referrer, 'referrer'), optionalString(body.landingPage, 'landingPage'), optionalString(body.clientId, 'clientId'));
    return send(response, 201, serializeLead(getLead.get(Number(result.lastInsertRowid))), corsHeaders(request));
  }

  if (request.method === 'GET' && url.pathname === '/leads') {
    const stage = url.searchParams.get('stage'); const source = url.searchParams.get('source');
    if (stage && !STAGE_RANK.has(stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    const clauses = []; const params = [];
    if (stage) { clauses.push('stage = ?'); params.push(stage); }
    if (source) { clauses.push('source = ?'); params.push(source); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM leads${where} ORDER BY created_at DESC, id DESC`).all(...params);
    return send(response, 200, { leads: rows.map(serializeLead) });
  }

  let match = url.pathname.match(/^\/leads\/(\d+)$/);
  if (request.method === 'GET' && match) {
    const row = existingLead(leadId(match[1]));
    return send(response, 200, { ...serializeLead(row), messages: getMessages.all(row.id).map(serializeMessage), stageHistory: getHistory.all(row.id).map(serializeHistory) });
  }
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]); existingLead(id); const body = await readJson(request);
    const allowed = { name: 'name', contact: 'contact', tag: 'tag', comment: 'comment' };
    const sets = []; const values = [];
    for (const [field, column] of Object.entries(allowed)) {
      if (body[field] !== undefined) { sets.push(`${column} = ?`); values.push(field === 'name' || field === 'contact' ? requiredString(body[field], field) : optionalString(body[field], field)); }
    }
    if (!sets.length) fail(400, 'Не передано ни одного изменяемого поля');
    sets.push('updated_at = ?'); values.push(new Date().toISOString(), id);
    db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return send(response, 200, serializeLead(getLead.get(id)));
  }

  match = url.pathname.match(/^\/leads\/(\d+)\/messages$/);
  if (request.method === 'GET' && match) { const id = leadId(match[1]); existingLead(id); return send(response, 200, { messages: getMessages.all(id).map(serializeMessage) }); }
  if (request.method === 'POST' && match) {
    const id = leadId(match[1]); existingLead(id); const body = await readJson(request);
    const result = insertMessage.run(id, new Date().toISOString(), requiredString(body.author, 'author'), requiredString(body.text, 'text'));
    return send(response, 201, serializeMessage(getMessage.get(Number(result.lastInsertRowid))));
  }

  match = url.pathname.match(/^\/leads\/(\d+)\/stage$/);
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]); const lead = existingLead(id); const body = await readJson(request);
    if (!STAGE_RANK.has(body.stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    if (body.stage === lead.stage) return send(response, 200, serializeLead(lead));
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try { updateStage.run(body.stage, now, id); insertHistory.run(id, lead.stage, body.stage, now); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    return send(response, 200, serializeLead(getLead.get(id)));
  }

  match = url.pathname.match(/^\/leads\/(\d+)\/sale$/);
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]); const lead = existingLead(id); const body = await readJson(request);
    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0) fail(400, 'Поле «amount» должно быть неотрицательным числом');
    const now = new Date().toISOString(); const soldAt = date(body.soldAt, 'soldAt', now);
    db.exec('BEGIN');
    try { updateSale.run(body.amount, soldAt, now, id); insertHistory.run(id, lead.stage, 'продажа', now); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    return send(response, 200, serializeLead(getLead.get(id)));
  }

  if (request.method === 'POST' && url.pathname === '/costs') {
    const body = await readJson(request); const source = requiredString(body.source, 'source');
    const spentOn = date(body.spentOn, 'spentOn');
    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0) fail(400, 'Поле «amount» должно быть неотрицательным числом');
    const result = db.prepare('INSERT INTO costs (source, spent_on, amount) VALUES (?, ?, ?)').run(source, spentOn, body.amount);
    return send(response, 201, { id: Number(result.lastInsertRowid), source, spentOn, amount: body.amount });
  }
  if (request.method === 'GET' && url.pathname === '/costs') {
    const rows = db.prepare('SELECT * FROM costs ORDER BY spent_on DESC, id DESC').all();
    return send(response, 200, { costs: rows.map((row) => ({ id: row.id, source: row.source, spentOn: row.spent_on, amount: row.amount })) });
  }

  if (request.method === 'GET' && url.pathname === '/summary') {
    const from = date(url.searchParams.get('from'), 'from'); const to = date(url.searchParams.get('to'), 'to');
    if (from > to) fail(400, 'Дата «from» не может быть позже «to»');
    const rows = db.prepare('SELECT source, stage, sale_amount FROM leads WHERE created_at >= ? AND created_at <= ?').all(from, to);
    const costs = db.prepare('SELECT source, SUM(amount) amount FROM costs WHERE spent_on >= ? AND spent_on <= ? GROUP BY source').all(from, to);
    const groups = new Map();
    function groupFor(source) { const key = source || 'не указан'; if (!groups.has(key)) groups.set(key, { source: key, leads: 0, booked: 0, visited: 0, sales: 0, revenue: 0, cost: 0, profit: 0, romi: null }); return groups.get(key); }
    for (const row of rows) {
      const group = groupFor(row.source); group.leads += 1; const rank = STAGE_RANK.get(row.stage);
      if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('записан')) group.booked += 1;
      if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('пришёл')) group.visited += 1;
      if (row.stage === 'продажа') group.sales += 1; if (row.sale_amount !== null) group.revenue += row.sale_amount;
    }
    for (const row of costs) groupFor(row.source).cost = row.amount;
    for (const group of groups.values()) { group.profit = group.revenue - group.cost; group.romi = group.cost === 0 ? null : group.profit / group.cost * 100; }
    return send(response, 200, { from, to, sources: [...groups.values()].sort((a, b) => a.source.localeCompare(b.source, 'ru')) });
  }

  if (request.method === 'GET' && url.pathname === '/export.csv') {
    const rows = db.prepare('SELECT * FROM leads ORDER BY created_at, id').all();
    const columns = Object.keys(rows[0] || Object.fromEntries(db.prepare('PRAGMA table_info(leads)').all().map((column) => [column.name, ''])));
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const body = `\uFEFF${columns.map(escape).join(';')}\r\n${rows.map((row) => columns.map((column) => escape(row[column])).join(';')).join('\r\n')}`;
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leads.csv"', 'content-length': Buffer.byteLength(body) });
    return response.end(body);
  }
  fail(404, 'Метод или адрес не найден');
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    send(response, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервиса', ...(error.details ? { details: error.details } : {}) }, corsHeaders(request));
  });
});
server.listen(PORT, () => console.log(`Мини-CRM слушает порт ${PORT}; база: ${DATABASE_PATH}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
