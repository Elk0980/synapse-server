'use strict';

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/crm.sqlite';
const STAGES = ['новая', 'в работе', 'записан', 'пришёл', 'продажа', 'отказ'];
const STAGE_RANK = new Map(STAGES.map((stage, index) => [stage, index]));

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535');
}

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
    comment TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads(stage);
  CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source);
  CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at);
  CREATE INDEX IF NOT EXISTS messages_lead_id_idx ON messages(lead_id);
`);

const createLead = db.prepare(`
  INSERT INTO leads
    (created_at, name, contact, channel, source, tag, page, first_question, stage, comment)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'новая', ?)
`);
const getLead = db.prepare('SELECT * FROM leads WHERE id = ?');
const getMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const insertMessage = db.prepare(
  'INSERT INTO messages (lead_id, created_at, author, text) VALUES (?, ?, ?, ?)'
);
const updateStage = db.prepare('UPDATE leads SET stage = ? WHERE id = ?');
const updateSale = db.prepare(
  "UPDATE leads SET stage = 'продажа', sale_amount = ?, sold_at = ? WHERE id = ?"
);

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
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
    if (size > 1024 * 1024) fail(413, 'Тело запроса не должно превышать 1 МБ');
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

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(400, `Поле «${field}» обязательно и должно быть непустой строкой`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(400, `Поле «${field}» должно быть строкой`);
  return value.trim() || null;
}

function leadId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный идентификатор заявки');
  return id;
}

function date(value, field, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(400, `Поле «${field}» должно содержать дату в формате ISO 8601`);
  }
  return new Date(value).toISOString();
}

function serializeLead(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    name: row.name,
    contact: row.contact,
    channel: row.channel,
    source: row.source,
    tag: row.tag,
    page: row.page,
    firstQuestion: row.first_question,
    stage: row.stage,
    saleAmount: row.sale_amount,
    soldAt: row.sold_at,
    comment: row.comment,
  };
}

function serializeMessage(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    createdAt: row.created_at,
    author: row.author,
    text: row.text,
  };
}

function existingLead(id) {
  const row = getLead.get(id);
  if (!row) fail(404, 'Заявка не найдена');
  return row;
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'POST' && url.pathname === '/leads') {
    const body = await readJson(request);
    const result = createLead.run(
      new Date().toISOString(),
      requiredString(body.name, 'name'),
      requiredString(body.contact, 'contact'),
      optionalString(body.channel, 'channel'),
      optionalString(body.source, 'source'),
      optionalString(body.tag, 'tag'),
      optionalString(body.page, 'page'),
      optionalString(body.firstQuestion, 'firstQuestion'),
      optionalString(body.comment, 'comment')
    );
    return send(response, 201, serializeLead(getLead.get(Number(result.lastInsertRowid))));
  }

  if (request.method === 'GET' && url.pathname === '/leads') {
    const stage = url.searchParams.get('stage');
    const source = url.searchParams.get('source');
    if (stage && !STAGE_RANK.has(stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    const clauses = [];
    const params = [];
    if (stage) { clauses.push('stage = ?'); params.push(stage); }
    if (source) { clauses.push('source = ?'); params.push(source); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM leads${where} ORDER BY created_at DESC, id DESC`).all(...params);
    return send(response, 200, { leads: rows.map(serializeLead) });
  }

  let match = url.pathname.match(/^\/leads\/(\d+)\/messages$/);
  if (request.method === 'POST' && match) {
    const id = leadId(match[1]);
    existingLead(id);
    const body = await readJson(request);
    const result = insertMessage.run(
      id,
      new Date().toISOString(),
      requiredString(body.author, 'author'),
      requiredString(body.text, 'text')
    );
    return send(response, 201, serializeMessage(getMessage.get(Number(result.lastInsertRowid))));
  }

  match = url.pathname.match(/^\/leads\/(\d+)\/stage$/);
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]);
    existingLead(id);
    const body = await readJson(request);
    if (!STAGE_RANK.has(body.stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    updateStage.run(body.stage, id);
    return send(response, 200, serializeLead(getLead.get(id)));
  }

  match = url.pathname.match(/^\/leads\/(\d+)\/sale$/);
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]);
    existingLead(id);
    const body = await readJson(request);
    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0) {
      fail(400, 'Поле «amount» должно быть неотрицательным числом');
    }
    updateSale.run(body.amount, date(body.soldAt, 'soldAt', new Date().toISOString()), id);
    return send(response, 200, serializeLead(getLead.get(id)));
  }

  if (request.method === 'GET' && url.pathname === '/summary') {
    const from = date(url.searchParams.get('from'), 'from');
    const to = date(url.searchParams.get('to'), 'to');
    if (from > to) fail(400, 'Дата «from» не может быть позже «to»');
    const rows = db.prepare(`
      SELECT source, stage, sale_amount FROM leads
      WHERE created_at >= ? AND created_at <= ?
    `).all(from, to);
    const groups = new Map();
    for (const row of rows) {
      const key = row.source || 'не указан';
      if (!groups.has(key)) groups.set(key, { source: key, leads: 0, booked: 0, visited: 0, sales: 0, revenue: 0 });
      const group = groups.get(key);
      group.leads += 1;
      const rank = STAGE_RANK.get(row.stage);
      if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('записан')) group.booked += 1;
      if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('пришёл')) group.visited += 1;
      if (row.stage === 'продажа') group.sales += 1;
      if (row.sale_amount !== null) group.revenue += row.sale_amount;
    }
    return send(response, 200, { from, to, sources: [...groups.values()].sort((a, b) => a.source.localeCompare(b.source, 'ru')) });
  }

  fail(404, 'Метод или адрес не найден');
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    send(response, error.status || 500, {
      error: error.status ? error.message : 'Внутренняя ошибка сервиса',
      ...(error.details ? { details: error.details } : {}),
    });
  });
});

server.listen(PORT, () => {
  console.log(`Мини-CRM слушает порт ${PORT}; база: ${DATABASE_PATH}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
