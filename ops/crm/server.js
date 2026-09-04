'use strict';

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/crm.sqlite';
const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
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

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535');
if (!API_KEY) throw new Error('API_KEY обязателен');
if (
  !Number.isInteger(RATE_LIMIT_WINDOW_MS) ||
  RATE_LIMIT_WINDOW_MS < 1 ||
  !Number.isInteger(RATE_LIMIT_MAX) ||
  RATE_LIMIT_MAX < 1
)
  throw new Error('Параметры rate limit должны быть положительными целыми числами');

const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, name TEXT NOT NULL, contact TEXT NOT NULL,
    channel TEXT, source TEXT, tag TEXT, page TEXT, first_question TEXT,
    stage TEXT NOT NULL DEFAULT 'новая' CHECK (stage IN ('новая','в работе','записан','пришёл','продажа','отказ')),
    sale_amount REAL CHECK (sale_amount IS NULL OR sale_amount >= 0), sold_at TEXT, comment TEXT
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
  contact_key: 'TEXT',
};
const existingColumns = new Set(
  db
    .prepare('PRAGMA table_info(leads)')
    .all()
    .map((column) => column.name),
);
for (const [name, type] of Object.entries(attributionColumns)) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
}
db.exec(`
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
    spent_at TEXT NOT NULL,
    source TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    comment TEXT
  );
  CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads(stage);
  CREATE INDEX IF NOT EXISTS leads_source_idx ON leads(source);
  CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at);
  CREATE INDEX IF NOT EXISTS messages_lead_id_idx ON messages(lead_id);
  CREATE INDEX IF NOT EXISTS stage_history_lead_id_idx ON stage_history(lead_id);
  CREATE INDEX IF NOT EXISTS expenses_spent_at_idx ON expenses(spent_at);
`);
function contactKey(value) {
  return value.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]/gu, '');
}
const missingContactKeys = db
  .prepare("SELECT id, contact FROM leads WHERE contact_key IS NULL OR contact_key = ''")
  .all();
const setContactKey = db.prepare('UPDATE leads SET contact_key = ? WHERE id = ?');
for (const row of missingContactKeys) setContactKey.run(contactKey(row.contact), row.id);
db.exec('CREATE INDEX IF NOT EXISTS leads_contact_key_idx ON leads(contact_key)');

const createLead = db.prepare(
  `INSERT INTO leads (
    created_at, name, contact, contact_key, channel, source, tag, page, first_question, stage, comment,
    utm_source, utm_medium, utm_campaign, utm_content, client_id, referrer, landing_page
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'новая', ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const getLead = db.prepare('SELECT * FROM leads WHERE id = ?');
const getLeadByContact = db.prepare('SELECT * FROM leads WHERE contact_key = ? ORDER BY id LIMIT 1');
const getMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const insertMessage = db.prepare('INSERT INTO messages (lead_id,created_at,author,text) VALUES (?,?,?,?)');
const updateStage = db.prepare('UPDATE leads SET stage = ? WHERE id = ?');
const updateSale = db.prepare("UPDATE leads SET stage = 'продажа', sale_amount = ?, sold_at = ? WHERE id = ?");
const insertHistory = db.prepare('INSERT INTO stage_history (lead_id,created_at,from_stage,to_stage) VALUES (?,?,?,?)');

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-headers': 'Content-Type, X-API-Key',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  };
}
function send(request, response, status, payload, contentType = 'application/json; charset=utf-8') {
  const body = contentType.startsWith('application/json') ? JSON.stringify(payload) : payload;
  response.writeHead(status, {
    ...corsHeaders(request),
    'content-type': contentType,
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
  if (!chunks.length) fail(400, 'Ожидалось тело запроса в формате JSON');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object')
      fail(400, 'Тело запроса должно быть JSON-объектом');
    return value;
  } catch (error) {
    if (error.status) throw error;
    fail(400, 'Некорректный JSON');
  }
}
function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim())
    fail(400, `Поле «${field}» обязательно и должно быть непустой строкой`);
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
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    fail(400, `Поле «${field}» должно содержать дату в формате ISO 8601`);
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
function cabinetPeriod(period) {
  const now = new Date(),
    from = new Date(now);
  if (period === 'today') from.setUTCHours(0, 0, 0, 0);
  else if (period === '7d') from.setUTCDate(from.getUTCDate() - 7);
  else if (period === '30d') from.setUTCDate(from.getUTCDate() - 30);
  else fail(400, 'Неизвестный период', { allowed: ['today', '7d', '30d'] });
  return from.toISOString();
}
function serializeMessage(row) {
  return { id: row.id, leadId: row.lead_id, createdAt: row.created_at, author: row.author, text: row.text };
}
function existingLead(id) {
  const row = getLead.get(id);
  if (!row) fail(404, 'Заявка не найдена');
  return row;
}
function changeStage(id, stage, at = new Date().toISOString()) {
  const row = existingLead(id);
  if (row.stage !== stage) {
    updateStage.run(stage, id);
    insertHistory.run(id, at, row.stage, stage);
  }
}
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function metricGroups(rows, expenses) {
  const groups = new Map();
  const ensure = (source) => {
    const key = source || 'не указан';
    if (!groups.has(key))
      groups.set(key, { source: key, leads: 0, booked: 0, visited: 0, sales: 0, revenue: 0, expenses: 0, romi: null });
    return groups.get(key);
  };
  for (const row of rows) {
    const group = ensure(row.source),
      rank = STAGE_RANK.get(row.stage);
    group.leads++;
    if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('записан')) group.booked++;
    if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('пришёл')) group.visited++;
    if (row.stage === 'продажа') group.sales++;
    group.revenue += row.sale_amount || 0;
  }
  for (const row of expenses) ensure(row.source).expenses += row.amount;
  for (const group of groups.values())
    group.romi = group.expenses === 0 ? null : (group.revenue - group.expenses) / group.expenses;
  return [...groups.values()].sort((a, b) => a.source.localeCompare(b.source, 'ru'));
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'OPTIONS') {
    const origin = request.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) fail(403, 'Источник CORS не разрешён');
    return send(request, response, 204, '');
  }
  if (!(request.method === 'POST' && url.pathname === '/leads') && request.headers['x-api-key'] !== API_KEY)
    fail(401, 'Требуется корректный X-API-Key');
  if (request.method === 'GET' && url.pathname === '/dashboard') {
    const from = cabinetPeriod(url.searchParams.get('period') || 'today'),
      requestedStage = url.searchParams.get('stage'),
      stage = requestedStage ? CABINET_STAGES.get(requestedStage) : null;
    if (requestedStage && !stage) fail(400, 'Неизвестный этап', { allowed: [...CABINET_STAGES.keys()] });
    const source = url.searchParams.get('source'),
      clauses = ['created_at >= ?'],
      params = [from];
    if (stage) {
      clauses.push('stage = ?');
      params.push(stage);
    }
    if (source) {
      clauses.push('source = ?');
      params.push(source);
    }
    const rows = db
        .prepare(`SELECT * FROM leads WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC`)
        .all(...params),
      expenses = db.prepare('SELECT source, amount FROM expenses WHERE spent_at >= ?').all(from),
      groups = metricGroups(rows, expenses),
      totals = groups.reduce((a, g) => ({ expenses: a.expenses + g.expenses, revenue: a.revenue + g.revenue }), {
        expenses: 0,
        revenue: 0,
      });
    const allSources = db
      .prepare("SELECT DISTINCT source FROM leads WHERE source IS NOT NULL AND source != '' ORDER BY source")
      .all();
    const funnel = Object.fromEntries(
      [...CABINET_STAGES].map(([id, name]) => {
        const count = rows.filter((row) => row.stage === name).length;
        return [id, { count, conversion: rows.length ? Math.round((count / rows.length) * 100) : 0 }];
      }),
    );
    return send(request, response, 200, {
      sample: false,
      summary: {
        total: rows.length,
        booked: rows.filter((row) => row.stage !== 'отказ' && STAGE_RANK.get(row.stage) >= STAGE_RANK.get('записан'))
          .length,
        visited: rows.filter((row) => row.stage !== 'отказ' && STAGE_RANK.get(row.stage) >= STAGE_RANK.get('пришёл'))
          .length,
        sales: rows.filter((row) => row.stage === 'продажа').length,
        revenue: totals.revenue,
        expenses: totals.expenses,
        romi: totals.expenses === 0 ? null : (totals.revenue - totals.expenses) / totals.expenses,
      },
      funnel,
      leads: rows.map(serializeCabinetLead),
      sources: allSources.map((row) => row.source),
    });
  }
  if (request.method === 'POST' && url.pathname === '/leads') {
    const body = await readJson(request),
      contact = requiredString(body.contact, 'contact'),
      key = contactKey(contact),
      duplicate = getLeadByContact.get(key);
    if (duplicate) return send(request, response, 200, { ...serializeLead(duplicate), deduplicated: true });
    const now = new Date().toISOString(),
      result = createLead.run(
        now,
        requiredString(body.name, 'name'),
        contact,
        key,
        optionalString(body.channel, 'channel'),
        optionalString(body.source, 'source') || optionalString(body.utmSource, 'utmSource'),
        optionalString(body.tag, 'tag'),
        optionalString(body.page, 'page') || optionalString(body.landingPage, 'landingPage'),
        optionalString(body.firstQuestion, 'firstQuestion'),
        optionalString(body.comment, 'comment'),
        optionalString(body.utmSource, 'utmSource'),
        optionalString(body.utmMedium, 'utmMedium'),
        optionalString(body.utmCampaign, 'utmCampaign'),
        optionalString(body.utmContent, 'utmContent'),
        optionalString(body.clientId, 'clientId'),
        optionalString(body.referrer, 'referrer'),
        optionalString(body.landingPage, 'landingPage'),
      );
    const id = Number(result.lastInsertRowid);
    insertHistory.run(id, now, null, 'новая');
    return send(request, response, 201, serializeLead(getLead.get(id)));
  }
  if (request.method === 'GET' && (url.pathname === '/leads' || url.pathname === '/leads.csv')) {
    const stage = url.searchParams.get('stage'),
      source = url.searchParams.get('source');
    if (stage && !STAGE_RANK.has(stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    const clauses = [],
      params = [];
    if (stage) {
      clauses.push('stage = ?');
      params.push(stage);
    }
    if (source) {
      clauses.push('source = ?');
      params.push(source);
    }
    const rows = db
      .prepare(
        `SELECT * FROM leads${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...params);
    if (url.pathname === '/leads.csv') {
      const fields = [
        'id',
        'created_at',
        'name',
        'contact',
        'channel',
        'source',
        'stage',
        'sale_amount',
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_content',
        'client_id',
        'referrer',
        'landing_page',
      ];
      return send(
        request,
        response,
        200,
        [fields.join(','), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))].join('\r\n') +
          '\r\n',
        'text/csv; charset=utf-8',
      );
    }
    return send(request, response, 200, { leads: rows.map(serializeLead) });
  }
  let match = url.pathname.match(/^\/leads\/(\d+)\/messages$/);
  if (request.method === 'POST' && match) {
    const id = leadId(match[1]);
    existingLead(id);
    const body = await readJson(request),
      result = insertMessage.run(
        id,
        new Date().toISOString(),
        requiredString(body.author, 'author'),
        requiredString(body.text, 'text'),
      );
    return send(request, response, 201, serializeMessage(getMessage.get(Number(result.lastInsertRowid))));
  }
  match = url.pathname.match(/^\/leads\/(\d+)$/);
  if (request.method === 'GET' && match) {
    const id = leadId(match[1]),
      lead = existingLead(id);
    return send(request, response, 200, {
      ...serializeLead(lead),
      messages: db
        .prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at,id')
        .all(id)
        .map(serializeMessage),
      stageHistory: db
        .prepare(
          `SELECT id, created_at AS createdAt, from_stage AS fromStage, to_stage AS toStage
           FROM stage_history WHERE lead_id = ? ORDER BY created_at, id`,
        )
        .all(id),
    });
  }
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]);
    existingLead(id);
    const body = await readJson(request);
    if (body.stage !== undefined) {
      const stage = CABINET_STAGES.get(body.stage);
      if (!stage) fail(400, 'Неизвестный этап', { allowed: [...CABINET_STAGES.keys()] });
      changeStage(id, stage);
    } else if (body.amount !== undefined) {
      if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0)
        fail(400, 'Поле «amount» должно быть неотрицательным числом');
      changeStage(id, 'продажа');
      updateSale.run(body.amount, new Date().toISOString(), id);
    } else fail(400, 'Нужно передать поле «stage» или «amount»');
    return send(request, response, 200, serializeCabinetLead(getLead.get(id)));
  }
  match = url.pathname.match(/^\/leads\/(\d+)\/stage$/);
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]),
      body = await readJson(request);
    if (!STAGE_RANK.has(body.stage)) fail(400, 'Неизвестный этап', { allowed: STAGES });
    changeStage(id, body.stage);
    return send(request, response, 200, serializeLead(getLead.get(id)));
  }
  match = url.pathname.match(/^\/leads\/(\d+)\/sale$/);
  if (request.method === 'PATCH' && match) {
    const id = leadId(match[1]),
      body = await readJson(request);
    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0)
      fail(400, 'Поле «amount» должно быть неотрицательным числом');
    const soldAt = date(body.soldAt, 'soldAt', new Date().toISOString());
    changeStage(id, 'продажа', soldAt);
    updateSale.run(body.amount, soldAt, id);
    return send(request, response, 200, serializeLead(getLead.get(id)));
  }
  if (request.method === 'POST' && url.pathname === '/expenses') {
    const body = await readJson(request),
      amount = body.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
      fail(400, 'Поле «amount» должно быть неотрицательным числом');
    const spentAt = date(body.spentAt, 'spentAt', new Date().toISOString()),
      source = requiredString(body.source, 'source'),
      comment = optionalString(body.comment, 'comment'),
      result = db
        .prepare('INSERT INTO expenses (spent_at,source,amount,comment) VALUES (?,?,?,?)')
        .run(spentAt, source, amount, comment);
    return send(request, response, 201, { id: Number(result.lastInsertRowid), spentAt, source, amount, comment });
  }
  if (request.method === 'GET' && url.pathname === '/expenses') {
    const from = date(url.searchParams.get('from'), 'from'),
      to = date(url.searchParams.get('to'), 'to');
    return send(request, response, 200, {
      expenses: db
        .prepare(
          `SELECT id, spent_at AS spentAt, source, amount, comment
           FROM expenses WHERE spent_at >= ? AND spent_at <= ? ORDER BY spent_at, id`,
        )
        .all(from, to),
    });
  }
  if (request.method === 'GET' && url.pathname === '/summary') {
    const from = date(url.searchParams.get('from'), 'from'),
      to = date(url.searchParams.get('to'), 'to');
    if (from > to) fail(400, 'Дата «from» не может быть позже «to»');
    const rows = db
        .prepare('SELECT source,stage,sale_amount FROM leads WHERE created_at >= ? AND created_at <= ?')
        .all(from, to),
      expenses = db.prepare('SELECT source,amount FROM expenses WHERE spent_at >= ? AND spent_at <= ?').all(from, to);
    return send(request, response, 200, { from, to, sources: metricGroups(rows, expenses) });
  }
  fail(404, 'Метод или адрес не найден');
}
const buckets = new Map();
function limited(request) {
  const now = Date.now(),
    key = request.socket.remoteAddress || 'unknown',
    recent = (buckets.get(key) || []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  buckets.set(key, recent);
  return false;
}
const server = http.createServer((request, response) => {
  if (limited(request)) return send(request, response, 429, { error: 'Слишком много запросов' });
  route(request, response).catch((error) => {
    console.error(error);
    send(request, response, error.status || 500, {
      error: error.status ? error.message : 'Внутренняя ошибка сервиса',
      ...(error.details ? { details: error.details } : {}),
    });
  });
});
server.listen(PORT, () => console.log(`Мини-CRM слушает порт ${PORT}; база: ${DATABASE_PATH}`));
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
