'use strict';

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/crm.sqlite';
const API_KEY = (process.env.API_KEY || '').trim();
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)
);
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '120', 10);
const STAGES = ['новая', 'в работе', 'записан', 'пришёл', 'продажа', 'отказ'];
const STAGE_RANK = new Map(STAGES.map((stage, index) => [stage, index]));
const CABINET_STAGES = new Map([
  ['new', 'новая'],
  ['in_progress', 'в работе'],
  ['booked', 'записан'],
  ['visited', 'пришёл'],
  ['sale', 'продажа'],
  ['rejected', 'отказ'],
]);
const CABINET_STAGE_IDS = new Map([...CABINET_STAGES].map(([id, stage]) => [stage, id]));
const rateLimits = new Map();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535');
}
if (!API_KEY) throw new Error('API_KEY обязателен');
if (!Number.isInteger(RATE_LIMIT_WINDOW_MS) || RATE_LIMIT_WINDOW_MS < 1) {
  throw new Error('RATE_LIMIT_WINDOW_MS должен быть положительным целым числом');
}
if (!Number.isInteger(RATE_LIMIT_MAX) || RATE_LIMIT_MAX < 1) {
  throw new Error('RATE_LIMIT_MAX должен быть положительным целым числом');
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
  CREATE TABLE IF NOT EXISTS stage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    spent_at TEXT NOT NULL,
    source TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    comment TEXT
  );
`);

const attributionColumns = {
  utm_source: 'TEXT',
  utm_medium: 'TEXT',
  utm_campaign: 'TEXT',
  utm_content: 'TEXT',
  client_id: 'TEXT',
  referrer: 'TEXT',
  landing_page: 'TEXT',
  normalized_contact: 'TEXT',
};
const leadColumns = new Set(db.prepare('PRAGMA table_info(leads)').all().map((column) => column.name));
for (const [name, type] of Object.entries(attributionColumns)) {
  if (!leadColumns.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads(stage);
  CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source);
  CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at);
  CREATE INDEX IF NOT EXISTS leads_normalized_contact_idx ON leads(normalized_contact);
  CREATE INDEX IF NOT EXISTS messages_lead_id_idx ON messages(lead_id);
  CREATE INDEX IF NOT EXISTS stage_history_lead_id_idx ON stage_history(lead_id);
  CREATE INDEX IF NOT EXISTS expenses_spent_at_idx ON expenses(spent_at);
`);
const contactsToNormalize = db.prepare(
  'SELECT id, contact FROM leads WHERE normalized_contact IS NULL'
).all();
const saveNormalizedContact = db.prepare('UPDATE leads SET normalized_contact = ? WHERE id = ?');
for (const row of contactsToNormalize) saveNormalizedContact.run(normalizeContact(row.contact), row.id);

const createLead = db.prepare(`
  INSERT INTO leads (
    created_at, name, contact, normalized_contact, channel, source, tag, page, first_question,
    stage, comment, utm_source, utm_medium, utm_campaign, utm_content, client_id, referrer, landing_page
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'новая', ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getLead = db.prepare('SELECT * FROM leads WHERE id = ?');
const getLeadByContact = db.prepare(
  "SELECT * FROM leads WHERE normalized_contact = ? AND normalized_contact != '' ORDER BY id LIMIT 1"
);
const getMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const getMessages = db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at, id');
const getStageHistory = db.prepare(
  'SELECT * FROM stage_history WHERE lead_id = ? ORDER BY created_at, id'
);
const insertMessage = db.prepare(
  'INSERT INTO messages (lead_id, created_at, author, text) VALUES (?, ?, ?, ?)'
);
const insertStageHistory = db.prepare(
  'INSERT INTO stage_history (lead_id, created_at, from_stage, to_stage) VALUES (?, ?, ?, ?)'
);
const updateStage = db.prepare('UPDATE leads SET stage = ? WHERE id = ?');
const updateSale = db.prepare(
  "UPDATE leads SET stage = 'продажа', sale_amount = ?, sold_at = ? WHERE id = ?"
);
const insertExpense = db.prepare(
  'INSERT INTO expenses (created_at, spent_at, source, amount, comment) VALUES (?, ?, ?, ?, ?)'
);

function send(response, status, payload, headers) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...(headers || {}),
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

function nonNegativeNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(400, `Поле «${field}» должно быть неотрицательным числом`);
  }
  return value;
}

function leadId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный идентификатор заявки');
  return id;
}

function date(value, field, fallback) {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(400, `Поле «${field}» должно содержать дату в формате ISO 8601`);
  }
  return new Date(value).toISOString();
}

function normalizeContact(contact) {
  const digits = contact.replace(/\D/g, '');
  if (digits.length >= 7) return digits.length === 11 && digits[0] === '8' ? `7${digits.slice(1)}` : digits;
  return contact.trim().toLocaleLowerCase('ru');
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
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    clientId: row.client_id,
    referrer: row.referrer,
    landingPage: row.landing_page,
  };
}

function serializeCabinetLead(row) {
  return {
    id: row.id,
    date: row.created_at,
    name: row.name,
    contact: row.contact,
    channel: row.channel,
    source: row.source,
    tag: row.tag,
    stage: CABINET_STAGE_IDS.get(row.stage),
    amount: row.sale_amount,
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

function serializeStageHistory(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    createdAt: row.created_at,
    fromStage: row.from_stage,
    toStage: row.to_stage,
  };
}

function serializeExpense(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    spentAt: row.spent_at,
    source: row.source,
    amount: row.amount,
    comment: row.comment,
  };
}

function existingLead(id) {
  const row = getLead.get(id);
  if (!row) fail(404, 'Заявка не найдена');
  return row;
}

function changeStage(row, stage, soldAt) {
  if (row.stage === stage) return;
  updateStage.run(stage, row.id);
  insertStageHistory.run(row.id, soldAt || new Date().toISOString(), row.stage, stage);
}

function cabinetPeriod(period) {
  const now = new Date();
  const from = new Date(now);
  if (period === 'today') from.setUTCHours(0, 0, 0, 0);
  else if (period === '7d') from.setUTCDate(from.getUTCDate() - 7);
  else if (period === '30d') from.setUTCDate(from.getUTCDate() - 30);
  else fail(400, 'Неизвестный период', { allowed: ['today', '7d', '30d'] });
  return from.toISOString();
}

function totalExpense(from, to, source) {
  const clauses = ['spent_at >= ?'];
  const params = [from];
  if (to) {
    clauses.push('spent_at <= ?');
    params.push(to);
  }
  if (source) {
    clauses.push('source = ?');
    params.push(source);
  }
  const where = clauses.join(' AND ');
  return db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE ${where}`).get(...params).total;
}

function romi(revenue, expense) {
  return expense === 0 ? null : ((revenue - expense) / expense) * 100;
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin || (!ALLOWED_ORIGINS.has('*') && !ALLOWED_ORIGINS.has(origin))) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-API-Key',
    vary: 'Origin',
  };
}

function takeRateLimit(request) {
  const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '')
    .split(',')[0].trim();
  const now = Date.now();
  const recent = (rateLimits.get(ip) || []).filter((time) => time > now - RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) fail(429, 'Слишком много запросов');
  recent.push(now);
  rateLimits.set(ip, recent);
}

function requireApiKey(request) {
  if (request.headers['x-api-key'] !== API_KEY) fail(401, 'Неверный API-ключ');
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    return response.end();
  }
  takeRateLimit(request);
  if (!(request.method === 'POST' && url.pathname === '/leads')) requireApiKey(request);

  if (request.method === 'GET' && url.pathname === '/dashboard') {
    const from = cabinetPeriod(url.searchParams.get('period') || 'today');
    const requestedStage = url.searchParams.get('stage');
    const stage = requestedStage ? CABINET_STAGES.get(requestedStage) : null;
    if (requestedStage && !stage) fail(400, 'Неизвестный этап', { allowed: [...CABINET_STAGES.keys()] });
    const source = url.searchParams.get('source');
    const clauses = ['created_at >= ?'];
    const params = [from];
    if (stage) {
      clauses.push('stage = ?');
      params.push(stage);
    }
    if (source) {
      clauses.push('source = ?');
      params.push(source);
    }
    const rows = db.prepare(
      `SELECT * FROM leads WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
    ).all(...params);
    const allSources = db.prepare(
      "SELECT DISTINCT source FROM leads WHERE source IS NOT NULL AND source != '' ORDER BY source"
    ).all();
    const funnel = Object.fromEntries([...CABINET_STAGES].map(([id, name]) => {
      const count = rows.filter((row) => row.stage === name).length;
      return [id, { count, conversion: rows.length ? Math.round((count / rows.length) * 100) : 0 }];
    }));
    const revenue = rows.reduce((total, row) => total + (row.sale_amount || 0), 0);
    const expenses = totalExpense(from, null, source);
    return send(response, 200, {
      sample: false,
      summary: {
        total: rows.length,
        booked: rows.filter((row) => {
          return row.stage !== 'отказ' && STAGE_RANK.get(row.stage) >= STAGE_RANK.get('записан');
        }).length,
        visited: rows.filter((row) => {
          return row.stage !== 'отказ' && STAGE_RANK.get(row.stage) >= STAGE_RANK.get('пришёл');
        }).length,
        sales: rows.filter((row) => row.stage === 'продажа').length,
        revenue,
        expenses,
        romi: romi(revenue, expenses),
      },
      funnel,
      leads: rows.map(serializeCabinetLead),
      sources: allSources.map((row) => row.source),
    }, cors);
  }

  if (request.method === 'POST' && url.pathname === '/leads') {
    const body = await readJson(request);
    const contact = requiredString(body.contact, 'contact');
    const normalized = normalizeContact(contact);
    const duplicate = getLeadByContact.get(normalized);
    if (duplicate) return send(response, 200, { ...serializeLead(duplicate), deduplicated: true }, cors);
    const utmSource = optionalString(body.utmSource, 'utmSource');
    const landingPage = optionalString(body.landingPage, 'landingPage');
    const result = createLead.run(
      new Date().toISOString(),
      requiredString(body.name, 'name'),
      contact,
      normalized,
      optionalString(body.channel, 'channel'),
      optionalString(body.source, 'source') || utmSource,
      optionalString(body.tag, 'tag'),
      optionalString(body.page, 'page') || landingPage,
      optionalString(body.firstQuestion, 'firstQuestion'),
      optionalString(body.comment, 'comment'),
      utmSource,
      optionalString(body.utmMedium, 'utmMedium'),
      optionalString(body.utmCampaign, 'utmCampaign'),
      optionalString(body.utmContent, 'utmContent'),
      optionalString(body.clientId, 'clientId'),
      optionalString(body.referrer, 'referrer'),
      landingPage
    );
    const row = getLead.get(Number(result.lastInsertRowid));
    insertStageHistory.run(row.id, row.created_at, null, row.stage);
    return send(response, 201, { ...serializeLead(row), deduplicated: false }, cors);
  }

  if (request.method === 'GET' && url.pathname === '/leads') {
    const stage = url.searchParams.get('stage');
    const source = url.searchParams.get('source');
    if (stage && !STAGE_RANK.has(stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    const clauses = [];
    const params = [];
    if (stage) {
      clauses.push('stage = ?');
      params.push(stage);
    }
    if (source) {
      clauses.push('source = ?');
      params.push(source);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM leads${where} ORDER BY created_at DESC, id DESC`).all(...params);
    return send(response, 200, { leads: rows.map(serializeLead) }, cors);
  }

  if (request.method === 'GET' && url.pathname === '/leads.csv') {
    const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC, id DESC').all();
    const fields = ['id', 'created_at', 'name', 'contact', 'channel', 'source', 'tag', 'page', 'stage',
      'sale_amount', 'sold_at', 'comment', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
      'client_id', 'referrer', 'landing_page'];
    const csv = [fields.join(','), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))]
      .join('\r\n');
    response.writeHead(200, {
      ...cors,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="leads.csv"',
      'content-length': Buffer.byteLength(csv),
    });
    return response.end(csv);
  }

  if (request.method === 'POST' && url.pathname === '/expenses') {
    const body = await readJson(request);
    const now = new Date().toISOString();
    const result = insertExpense.run(
      now,
      date(body.spentAt ?? body.date, 'spentAt', now),
      requiredString(body.source, 'source'),
      nonNegativeNumber(body.amount, 'amount'),
      optionalString(body.comment, 'comment')
    );
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(result.lastInsertRowid));
    return send(response, 201, serializeExpense(row), cors);
  }

  if (request.method === 'GET' && url.pathname === '/expenses') {
    const from = url.searchParams.has('from') ? date(url.searchParams.get('from'), 'from') : null;
    const to = url.searchParams.has('to') ? date(url.searchParams.get('to'), 'to') : null;
    if (from && to && from > to) fail(400, 'Дата «from» не может быть позже «to»');
    const clauses = [];
    const params = [];
    if (from) {
      clauses.push('spent_at >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('spent_at <= ?');
      params.push(to);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM expenses${where} ORDER BY spent_at DESC, id DESC`).all(...params);
    return send(response, 200, { expenses: rows.map(serializeExpense) }, cors);
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
    return send(response, 201, serializeMessage(getMessage.get(Number(result.lastInsertRowid))), cors);
  }

  match = url.pathname.match(/^\/leads\/(\d+)$/);
  if (request.method === 'GET' && match) {
    const row = existingLead(leadId(match[1]));
    return send(response, 200, {
      ...serializeLead(row),
      messages: getMessages.all(row.id).map(serializeMessage),
      stageHistory: getStageHistory.all(row.id).map(serializeStageHistory),
    }, cors);
  }
  if (request.method === 'PATCH' && match) {
    const row = existingLead(leadId(match[1]));
    const body = await readJson(request);
    if (body.stage !== undefined) {
      const stage = CABINET_STAGES.get(body.stage);
      if (!stage) fail(400, 'Неизвестный этап', { allowed: [...CABINET_STAGES.keys()] });
      changeStage(row, stage);
    } else if (body.amount !== undefined) {
      const now = new Date().toISOString();
      nonNegativeNumber(body.amount, 'amount');
      updateSale.run(body.amount, now, row.id);
      if (row.stage !== 'продажа') insertStageHistory.run(row.id, now, row.stage, 'продажа');
    } else {
      fail(400, 'Нужно передать поле «stage» или «amount»');
    }
    return send(response, 200, serializeCabinetLead(getLead.get(row.id)), cors);
  }

  match = url.pathname.match(/^\/leads\/(\d+)\/stage$/);
  if (request.method === 'PATCH' && match) {
    const row = existingLead(leadId(match[1]));
    const body = await readJson(request);
    if (!STAGE_RANK.has(body.stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    changeStage(row, body.stage);
    return send(response, 200, serializeLead(getLead.get(row.id)), cors);
  }

  match = url.pathname.match(/^\/leads\/(\d+)\/sale$/);
  if (request.method === 'PATCH' && match) {
    const row = existingLead(leadId(match[1]));
    const body = await readJson(request);
    const soldAt = date(body.soldAt, 'soldAt', new Date().toISOString());
    updateSale.run(nonNegativeNumber(body.amount, 'amount'), soldAt, row.id);
    if (row.stage !== 'продажа') insertStageHistory.run(row.id, soldAt, row.stage, 'продажа');
    return send(response, 200, serializeLead(getLead.get(row.id)), cors);
  }

  if (request.method === 'GET' && url.pathname === '/summary') {
    const from = date(url.searchParams.get('from'), 'from');
    const to = date(url.searchParams.get('to'), 'to');
    if (from > to) fail(400, 'Дата «from» не может быть позже «to»');
    const rows = db.prepare(`
      SELECT source, stage, sale_amount FROM leads
      WHERE created_at >= ? AND created_at <= ?
    `).all(from, to);
    const expenseRows = db.prepare(`
      SELECT source, SUM(amount) AS expenses FROM expenses
      WHERE spent_at >= ? AND spent_at <= ? GROUP BY source
    `).all(from, to);
    const groups = new Map();
    const groupFor = (source) => {
      const key = source || 'не указан';
      if (!groups.has(key)) {
        groups.set(key, {
          source: key,
          leads: 0,
          booked: 0,
          visited: 0,
          sales: 0,
          revenue: 0,
          expenses: 0,
          romi: null,
        });
      }
      return groups.get(key);
    };
    for (const row of rows) {
      const group = groupFor(row.source);
      group.leads += 1;
      const rank = STAGE_RANK.get(row.stage);
      if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('записан')) group.booked += 1;
      if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('пришёл')) group.visited += 1;
      if (row.stage === 'продажа') group.sales += 1;
      if (row.sale_amount !== null) group.revenue += row.sale_amount;
    }
    for (const row of expenseRows) groupFor(row.source).expenses = row.expenses;
    for (const group of groups.values()) group.romi = romi(group.revenue, group.expenses);
    const sources = [...groups.values()].sort((a, b) => a.source.localeCompare(b.source, 'ru'));
    const revenue = sources.reduce((sum, group) => sum + group.revenue, 0);
    const expenses = sources.reduce((sum, group) => sum + group.expenses, 0);
    return send(response, 200, { from, to, revenue, expenses, romi: romi(revenue, expenses), sources }, cors);
  }

  fail(404, 'Метод или адрес не найден');
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    send(response, error.status || 500, {
      error: error.status ? error.message : 'Внутренняя ошибка сервиса',
      ...(error.details ? { details: error.details } : {}),
    }, corsHeaders(request));
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
