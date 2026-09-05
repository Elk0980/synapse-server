'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('node:url');

const IS_MAIN = require.main === module;
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.DATABASE_PATH || (IS_MAIN ? '/data/crm.sqlite' : ':memory:');
const API_KEY = (process.env.API_KEY || (IS_MAIN ? '' : 'module-test-key')).trim();
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
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
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

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function migrate(version, migration) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    migration();
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

migrate(1, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)), deleted_at TEXT,
      name TEXT NOT NULL, position TEXT, phone TEXT, normalized_phone TEXT, email TEXT,
      messengers TEXT, links TEXT, city TEXT, timezone TEXT, preferred_channel TEXT, notes TEXT,
      birth_date TEXT
    );
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)), deleted_at TEXT,
      code TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, industry TEXT, city TEXT, timezone TEXT,
      phone TEXT, email TEXT, website_url TEXT, socials TEXT, pipeline_stage TEXT,
      start_date TEXT, end_date TEXT, preferred_channel TEXT, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS legal_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)), deleted_at TEXT,
      legal_form TEXT NOT NULL CHECK(legal_form IN ('ip', 'ooo')), name TEXT NOT NULL, short_name TEXT,
      inn TEXT, kpp TEXT, ogrn TEXT, ogrnip TEXT, phone TEXT, email TEXT, legal_address TEXT,
      postal_address TEXT, tax_system TEXT, bank_name TEXT, bik TEXT, checking_account TEXT,
      correspondent_account TEXT, recipient_name TEXT, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS contact_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)), deleted_at TEXT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT NOT NULL, is_responsible INTEGER NOT NULL DEFAULT 0 CHECK(is_responsible IN (0, 1)),
      valid_from TEXT, valid_to TEXT, notes TEXT, UNIQUE(contact_id, company_id)
    );
    CREATE TABLE IF NOT EXISTS company_legal_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)), deleted_at TEXT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      legal_entity_id INTEGER NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
      role TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
      valid_from TEXT, valid_to TEXT, notes TEXT, UNIQUE(company_id, legal_entity_id)
    );
    CREATE TABLE IF NOT EXISTS contact_legal_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)), deleted_at TEXT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      legal_entity_id INTEGER NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
      role TEXT NOT NULL, is_signatory INTEGER NOT NULL DEFAULT 0 CHECK(is_signatory IN (0, 1)),
      signing_basis TEXT, valid_from TEXT, valid_to TEXT, notes TEXT,
      UNIQUE(contact_id, legal_entity_id)
    );
  `);
  const compatibleCompanyColumns = {
    created_at: 'TEXT', updated_at: 'TEXT', is_deleted: 'INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0,1))',
    deleted_at: 'TEXT', code: 'TEXT COLLATE NOCASE', name: 'TEXT', industry: 'TEXT', city: 'TEXT', timezone: 'TEXT',
    phone: 'TEXT', email: 'TEXT', website_url: 'TEXT', socials: 'TEXT', pipeline_stage: 'TEXT', start_date: 'TEXT',
    end_date: 'TEXT', preferred_channel: 'TEXT', notes: 'TEXT',
  };
  const existingCompanyColumns = tableColumns('companies');
  for (const [name, type] of Object.entries(compatibleCompanyColumns)) {
    if (!existingCompanyColumns.has(name)) db.exec(`ALTER TABLE companies ADD COLUMN ${name} ${type}`);
  }
  if (!tableColumns('leads').has('company_code')) {
    db.exec(`ALTER TABLE leads ADD COLUMN company_code TEXT COLLATE NOCASE REFERENCES companies(code)
      ON UPDATE CASCADE ON DELETE RESTRICT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS contacts_deleted_name_idx ON contacts(is_deleted, name);
    CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts(normalized_phone);
    CREATE UNIQUE INDEX IF NOT EXISTS companies_code_uidx ON companies(code COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS companies_search_idx ON companies(is_deleted, name, pipeline_stage);
    CREATE UNIQUE INDEX IF NOT EXISTS legal_entities_inn_uidx ON legal_entities(inn) WHERE inn IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS legal_entities_ogrn_uidx ON legal_entities(ogrn) WHERE ogrn IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS legal_entities_ogrnip_uidx ON legal_entities(ogrnip) WHERE ogrnip IS NOT NULL;
    CREATE INDEX IF NOT EXISTS legal_entities_search_idx ON legal_entities(is_deleted, name);
    CREATE INDEX IF NOT EXISTS contact_companies_company_idx ON contact_companies(company_id);
    CREATE INDEX IF NOT EXISTS company_legal_entities_legal_idx ON company_legal_entities(legal_entity_id);
    CREATE INDEX IF NOT EXISTS contact_legal_entities_legal_idx ON contact_legal_entities(legal_entity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS contact_companies_responsible_uidx
      ON contact_companies(company_id) WHERE is_deleted = 0 AND is_responsible = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS company_legal_entities_primary_uidx
      ON company_legal_entities(company_id) WHERE is_deleted = 0 AND is_primary = 1;
  `);
});

migrate(2, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
      deleted_at TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      company_code TEXT NOT NULL DEFAULT '',
      assignee_role TEXT NOT NULL DEFAULT 'synapse'
        CHECK(assignee_role IN ('owner', 'admin', 'marketer', 'synapse')),
      assignee_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox'
        CHECK(status IN ('inbox', 'planned', 'in_progress', 'done', 'cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
      due_date TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK(source IN ('manual', 'chat', 'telegram')),
      source_ref TEXT NOT NULL DEFAULT '',
      source_author TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS tasks_company_code_idx ON tasks(company_code);
    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
    CREATE INDEX IF NOT EXISTS tasks_source_ref_idx ON tasks(source_ref);
  `);
});

migrate(3, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('visit', 'click')),
      company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      client_id TEXT,
      page TEXT,
      landing_page TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,
      source TEXT NOT NULL,
      target TEXT,
      label TEXT,
      ip_hash TEXT NOT NULL,
      ua_short TEXT
    );
    CREATE INDEX IF NOT EXISTS events_company_created_idx ON events(company_code, created_at);
    CREATE INDEX IF NOT EXISTS events_source_idx ON events(source);
    CREATE INDEX IF NOT EXISTS events_client_id_idx ON events(client_id);
    CREATE TABLE IF NOT EXISTS external_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      date TEXT NOT NULL,
      metrics TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      note TEXT,
      UNIQUE(source, company_code, date)
    );
    CREATE INDEX IF NOT EXISTS external_stats_company_date_idx
      ON external_stats(company_code, date);
    CREATE INDEX IF NOT EXISTS external_stats_source_idx ON external_stats(source);
  `);
});

const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
if (foreignKeyErrors.length) throw new Error('Нарушена ссылочная целостность базы данных');

const attributionColumns = {
  utm_source: 'TEXT',
  utm_medium: 'TEXT',
  utm_campaign: 'TEXT',
  utm_content: 'TEXT',
  utm_term: 'TEXT',
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
  CREATE INDEX IF NOT EXISTS leads_company_created_idx ON leads(company_code, created_at);
  CREATE INDEX IF NOT EXISTS leads_company_stage_created_idx ON leads(company_code, stage, created_at);
  CREATE INDEX IF NOT EXISTS leads_company_contact_idx ON leads(company_code, normalized_contact);
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
    stage, comment, utm_source, utm_medium, utm_campaign, utm_content, utm_term, client_id,
    referrer, landing_page, company_code
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'новая', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getLead = db.prepare('SELECT * FROM leads WHERE id = ?');
const getLeadByContact = db.prepare(`SELECT * FROM leads WHERE normalized_contact = ?
  AND normalized_contact != '' AND company_code IS ? COLLATE NOCASE ORDER BY id LIMIT 1`);
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
const insertEvent = db.prepare(`
  INSERT INTO events (
    created_at, type, company_code, client_id, page, landing_page, referrer, utm_source,
    utm_medium, utm_campaign, utm_content, utm_term, source, target, label, ip_hash, ua_short
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertExternalStat = db.prepare(`
  INSERT INTO external_stats (source, company_code, date, metrics, captured_at, note)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, company_code, date) DO UPDATE SET
    metrics=excluded.metrics, captured_at=excluded.captured_at, note=excluded.note
`);

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

function limitedString(value, field, required = false, limit = 500) {
  const result = required ? requiredString(value, field) : optionalString(value, field);
  if (result && result.length > limit) {
    fail(400, `Поле «${field}» не должно превышать ${limit} символов`);
  }
  return result;
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

function rangeDate(value, field, endOfDay = false) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const start = moscowMidnightUtc(year, month, day);
    return new Date(start.getTime() + (endOfDay ? 24 * 60 * 60 * 1000 - 1 : 0)).toISOString();
  }
  return date(value, field);
}

const MOSCOW_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});
const MOSCOW_OFFSET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow', timeZoneName: 'longOffset',
});

function moscowMidnightUtc(year, month, day) {
  const approximate = new Date(Date.UTC(year, month - 1, day));
  const offsetName = MOSCOW_OFFSET.formatToParts(approximate)
    .find((part) => part.type === 'timeZoneName').value;
  const match = offsetName.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Не удалось определить часовой пояс Europe/Moscow');
  const offset = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
  return new Date(approximate.getTime() - offset * 60 * 1000);
}

function normalizeContact(contact) {
  const digits = contact.replace(/\D/g, '');
  if (digits.length >= 7) return digits.length === 11 && digits[0] === '8' ? `7${digits.slice(1)}` : digits;
  return contact.trim().toLocaleLowerCase('ru');
}

function deriveSource({ utmSource, referrer } = {}) {
  const utm = typeof utmSource === 'string' ? utmSource.trim().toLowerCase() : '';
  if (utm) return utm;
  if (typeof referrer !== 'string' || !referrer.trim()) return 'direct';
  let hostname;
  try {
    const value = referrer.trim();
    hostname = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return 'direct';
  }
  const host = hostname.replace(/^www\./, '').replace(/\.$/, '');
  if (/^(?:.+\.)?2gis\./.test(host)) return '2gis';
  if (/^(?:.+\.)?yandex\./.test(host) || host === 'ya.ru') return 'yandex';
  if (/^(?:.+\.)?google\./.test(host)) return 'google';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'vk.com' || host.endsWith('.vk.com') || host === 'vk.ru' || host.endsWith('.vk.ru')) {
    return 'vk';
  }
  if (host === 't.me' || host.endsWith('.t.me') || /^telegram\.[^.]+$/.test(host)) return 'telegram';
  if (host === 'wa.me' || host.endsWith('.wa.me') || /^whatsapp\.[^.]+$/.test(host)) {
    return 'whatsapp';
  }
  return host || 'direct';
}

const ENTITY_CONFIG = {
  contacts: {
    path: 'contacts', table: 'contacts', response: 'contacts', required: ['name'],
    fields: ['name', 'position', 'phone', 'email', 'messengers', 'links', 'city', 'timezone',
      'preferredChannel', 'notes', 'birthDate'],
    columns: { preferredChannel: 'preferred_channel', birthDate: 'birth_date' },
    private: new Set(['notes', 'birthDate']),
  },
  companies: {
    path: 'companies', table: 'companies', response: 'companies', required: ['code', 'name'],
    fields: ['code', 'name', 'industry', 'city', 'timezone', 'phone', 'email', 'websiteUrl', 'socials',
      'pipelineStage', 'startDate', 'endDate', 'preferredChannel', 'notes'],
    columns: { websiteUrl: 'website_url', pipelineStage: 'pipeline_stage', startDate: 'start_date',
      endDate: 'end_date', preferredChannel: 'preferred_channel' },
    private: new Set(['notes']),
  },
  tasks: {
    path: 'tasks', table: 'tasks', response: 'tasks', required: ['title'],
    fields: ['title', 'description', 'companyCode', 'assigneeRole', 'assigneeName', 'status',
      'priority', 'dueDate', 'source', 'sourceRef', 'sourceAuthor', 'createdBy'],
    columns: { companyCode: 'company_code', assigneeRole: 'assignee_role', assigneeName: 'assignee_name',
      dueDate: 'due_date', sourceRef: 'source_ref', sourceAuthor: 'source_author', createdBy: 'created_by' },
    defaults: { description: '', companyCode: '', assigneeRole: 'synapse', assigneeName: '', status: 'inbox',
      priority: 'normal', dueDate: '', source: 'manual', sourceRef: '', sourceAuthor: '', createdBy: '' },
    private: new Set(),
  },
  legalEntities: {
    path: 'legal-entities', table: 'legal_entities', response: 'legalEntities', required: ['legalForm', 'name'],
    fields: ['legalForm', 'name', 'shortName', 'inn', 'kpp', 'ogrn', 'ogrnip', 'phone', 'email',
      'legalAddress', 'postalAddress', 'taxSystem', 'bankName', 'bik', 'checkingAccount',
      'correspondentAccount', 'recipientName', 'notes'],
    columns: { legalForm: 'legal_form', shortName: 'short_name', legalAddress: 'legal_address',
      postalAddress: 'postal_address', taxSystem: 'tax_system', bankName: 'bank_name',
      checkingAccount: 'checking_account', correspondentAccount: 'correspondent_account',
      recipientName: 'recipient_name' },
    private: new Set(['legalAddress', 'postalAddress', 'taxSystem', 'bankName', 'bik', 'checkingAccount',
      'correspondentAccount', 'recipientName', 'notes']),
  },
};
const SYSTEM_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'isDeleted', 'deletedAt']);
const SECRET_PATTERN = /(password|token|api.?key|secret|cookie|private.?key|cvv|cvc|login|код.?подтверж)/i;
const PIPELINE_STAGES = new Set(['application', 'call', 'kit_ready', 'payment', 'active']);
const MESSENGER_TYPES = new Set(['telegram', 'max', 'whatsapp', 'vk', 'phone', 'email', 'other']);
const JSON_FIELDS = new Set(['messengers', 'links', 'socials']);

function entityId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректный идентификатор', { code: 'VALIDATION_ERROR' });
  return id;
}
function column(config, field) {
  return config.columns[field] || field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function checkedString(value, field, nullable = true) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') fail(400, `Поле «${field}» должно быть строкой`,
    { code: 'VALIDATION_ERROR', field });
  const result = value.trim();
  if (!result && !nullable) fail(400, `Поле «${field}» не может быть пустым`,
    { code: 'VALIDATION_ERROR', field });
  if (result.length > 2000) fail(400, `Поле «${field}» слишком длинное`,
    { code: 'VALIDATION_ERROR', field });
  return result || null;
}
function validUrl(value, field) {
  const result = checkedString(value, field, false);
  let parsed;
  try { parsed = new URL(result); } catch { fail(400, `Поле «${field}» содержит некорректную ссылку`,
    { code: 'VALIDATION_ERROR', field }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(400, `Поле «${field}» допускает только HTTP(S)`,
    { code: 'VALIDATION_ERROR', field });
  return result;
}
function validDay(value, field) {
  const result = checkedString(value, field, false);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(400, `Поле «${field}» должно иметь формат YYYY-MM-DD`,
    { code: 'VALIDATION_ERROR', field });
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) {
    fail(400, `Поле «${field}» содержит невозможную дату`, { code: 'VALIDATION_ERROR', field });
  }
  return result;
}
function validateArray(value, field) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 25) fail(400, `Поле «${field}» должно быть массивом до 25 элементов`,
    { code: 'VALIDATION_ERROR', field });
  const values = value.map((item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') fail(400, `Элемент «${field}» должен быть объектом`,
      { code: 'VALIDATION_ERROR', field });
    const allowed = field === 'links' ? ['label', 'url'] : ['type', 'label', 'handle', 'url'];
    if (Object.keys(item).some((key) => !allowed.includes(key))) fail(400, `Неизвестное поле в «${field}»`,
      { code: 'VALIDATION_ERROR', field });
    const out = {};
    for (const key of allowed) if (item[key] !== undefined) {
      out[key] = key === 'url' && item[key] !== null ? validUrl(item[key], `${field}.${key}`) :
        checkedString(item[key], `${field}.${key}`);
    }
    if (field === 'messengers') {
      if (!MESSENGER_TYPES.has(out.type)) fail(400, 'Неизвестный тип мессенджера',
        { code: 'VALIDATION_ERROR', field });
      if (!out.handle && !out.url) fail(400, 'У мессенджера нужен handle или url',
        { code: 'VALIDATION_ERROR', field });
    }
    if (field === 'links' && !out.url) fail(400, 'У ссылки нужен url', { code: 'VALIDATION_ERROR', field });
    return out;
  });
  return JSON.stringify(values);
}
const TASK_ENUMS = {
  assigneeRole: new Set(['owner', 'admin', 'marketer', 'synapse']),
  status: new Set(['inbox', 'planned', 'in_progress', 'done', 'cancelled']),
  priority: new Set(['low', 'normal', 'high', 'urgent']),
  source: new Set(['manual', 'chat', 'telegram']),
};

function validateTask(body, patch) {
  const keys = Object.keys(body);
  if (!keys.length) fail(400, 'Пустой объект нельзя изменить', { code: 'VALIDATION_ERROR' });
  const config = ENTITY_CONFIG.tasks;
  for (const key of keys) {
    if (SYSTEM_FIELDS.has(key) || SECRET_PATTERN.test(key) || !config.fields.includes(key)) {
      fail(400, `Неизвестное или запрещённое поле «${key}»`,
        { code: 'VALIDATION_ERROR', field: key });
    }
  }
  if (!patch && !Object.hasOwn(body, 'title')) {
    fail(400, 'Поле «title» обязательно', { code: 'VALIDATION_ERROR', field: 'title' });
  }
  const values = {};
  for (const field of config.fields) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== 'string') {
      fail(400, `Поле «${field}» должно быть строкой`, { code: 'VALIDATION_ERROR', field });
    }
    let value = body[field].trim();
    if (field === 'title' && (value.length < 1 || value.length > 200)) {
      fail(400, 'Название задачи должно содержать от 1 до 200 символов',
        { code: 'VALIDATION_ERROR', field });
    }
    if (field !== 'title' && value.length > 2000) {
      fail(400, `Поле «${field}» слишком длинное`, { code: 'VALIDATION_ERROR', field });
    }
    if (TASK_ENUMS[field] && !TASK_ENUMS[field].has(value)) {
      fail(400, `Недопустимое значение поля «${field}»`, { code: 'VALIDATION_ERROR', field });
    }
    if (field === 'dueDate' && value) value = validDay(value, field);
    if (field === 'companyCode' && value) {
      const company = db.prepare(
        'SELECT code FROM companies WHERE code = ? COLLATE NOCASE AND is_deleted = 0'
      ).get(value);
      if (!company) fail(400, 'Компания с таким кодом не найдена',
        { code: 'VALIDATION_ERROR', field });
      value = company.code.toLowerCase();
    }
    values[field] = value;
  }
  return values;
}

function validateEntity(config, body, patch = false, current = null) {
  if (config.table === 'tasks') return validateTask(body, patch);
  const keys = Object.keys(body);
  if (!keys.length) fail(400, 'Пустой объект нельзя изменить', { code: 'VALIDATION_ERROR' });
  for (const key of keys) {
    if (SYSTEM_FIELDS.has(key) || SECRET_PATTERN.test(key) || !config.fields.includes(key)) {
      fail(400, `Неизвестное или запрещённое поле «${key}»`, { code: 'VALIDATION_ERROR', field: key });
    }
  }
  const values = {};
  for (const field of config.fields) {
    if (!(field in body)) continue;
    if (config.required.includes(field) && (body[field] === null || body[field] === '')) {
      fail(400, `Поле «${field}» нельзя очистить`, { code: 'VALIDATION_ERROR', field });
    }
    let value = JSON_FIELDS.has(field) ? validateArray(body[field], field) : checkedString(body[field], field,
      !config.required.includes(field));
    if (field === 'code' && value !== null) {
      value = value.toLowerCase();
      if (!/^[a-z0-9_-]{2,64}$/.test(value)) fail(400, 'Некорректный код компании',
        { code: 'VALIDATION_ERROR', field });
    }
    if (field === 'legalForm' && !['ip', 'ooo'].includes(value)) fail(400, 'legalForm должен быть ip или ooo',
      { code: 'VALIDATION_ERROR', field });
    if (field === 'pipelineStage' && value !== null && !PIPELINE_STAGES.has(value)) {
      fail(400, 'Неизвестный этап компании', { code: 'VALIDATION_ERROR', field });
    }
    if (field === 'timezone' && value !== null) {
      try { new Intl.DateTimeFormat('ru', { timeZone: value }); } catch {
        fail(400, 'Некорректный часовой пояс IANA', { code: 'VALIDATION_ERROR', field });
      }
    }
    if (['birthDate', 'startDate', 'endDate'].includes(field) && value !== null) value = validDay(value, field);
    if (['websiteUrl'].includes(field) && value !== null) value = validUrl(value, field);
    values[field] = value;
  }
  if (!patch) for (const field of config.required) if (!(field in values)) fail(400, `Поле «${field}» обязательно`,
    { code: 'VALIDATION_ERROR', field });
  if (config.table === 'legal_entities') {
    const form = values.legalForm ?? current?.legal_form;
    const columns = Object.entries(values).map(([key, value]) => [column(config, key), value]);
    const all = { ...current, ...Object.fromEntries(columns) };
    const lengths = { kpp: 9, ogrn: 13, ogrnip: 15, bik: 9, checking_account: 20,
      correspondent_account: 20 };
    if (all.inn && !new RegExp(`^\\d{${form === 'ip' ? 12 : 10}}$`).test(all.inn)) {
      fail(400, 'ИНН имеет неверную длину', { code: 'VALIDATION_ERROR', field: 'inn' });
    }
    for (const [field, length] of Object.entries(lengths)) {
      if (!all[field] || new RegExp(`^\\d{${length}}$`).test(all[field])) continue;
      fail(400, `Поле «${field}» должно содержать ${length} цифр`, { code: 'VALIDATION_ERROR', field });
    }
    if (form === 'ip' && all.ogrn) fail(400, 'ОГРН несовместим с ИП', { code: 'VALIDATION_ERROR', field: 'ogrn' });
    if (form === 'ooo' && all.ogrnip) fail(400, 'ОГРНИП несовместим с ООО',
      { code: 'VALIDATION_ERROR', field: 'ogrnip' });
  }
  return values;
}
function serializeEntity(config, row, brief = false) {
  const result = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at,
    isDeleted: Boolean(row.is_deleted), deletedAt: row.deleted_at };
  for (const field of config.fields) {
    if (brief && config.private.has(field)) continue;
    const value = row[column(config, field)];
    result[field] = JSON_FIELDS.has(field) && value ? JSON.parse(value) : value;
  }
  return result;
}
function entityRow(config, id, includeDeleted = false) {
  const row = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(id);
  if (!row || (row.is_deleted && !includeDeleted)) fail(404, 'Карточка не найдена', { code: 'NOT_FOUND' });
  return row;
}
function conflict(error) {
  if (String(error.message).includes('UNIQUE constraint failed')) {
    fail(409, 'Значение уже используется', { code: 'UNIQUE_CONFLICT' });
  }
  throw error;
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
    utmTerm: row.utm_term,
    clientId: row.client_id,
    referrer: row.referrer,
    landingPage: row.landing_page,
    companyCode: row.company_code,
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
    companyCode: row.company_code,
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
  const parts = Object.fromEntries(MOSCOW_DATE.formatToParts(now)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const from = moscowMidnightUtc(parts.year, parts.month, parts.day);
  if (period === '7d') from.setUTCDate(from.getUTCDate() - 7);
  else if (period === '30d') from.setUTCDate(from.getUTCDate() - 30);
  else if (period !== 'today') fail(400, 'Неизвестный период', { allowed: ['today', '7d', '30d'] });
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

function activeCompanyCode(value) {
  const code = limitedString(value, 'companyCode', true).toLowerCase();
  const company = db.prepare('SELECT is_deleted FROM companies WHERE code=? COLLATE NOCASE').get(code);
  if (!company || company.is_deleted) {
    fail(400, 'Активная компания с таким кодом не найдена', {
      code: 'COMPANY_NOT_ACTIVE', field: 'companyCode',
    });
  }
  return code;
}

function requestIpHash(request) {
  const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '')
    .split(',')[0].trim();
  return createHash('sha256').update(`${ip}${API_KEY}`).digest('hex');
}

function analyticsData(from, to, companyCode, selectedSource, leadRows = []) {
  const groups = new Map();
  const groupFor = (source) => {
    const key = source || 'не указан';
    if (!groups.has(key)) {
      groups.set(key, {
        source: key, leads: 0, booked: 0, visited: 0, sales: 0, revenue: 0,
        expenses: companyCode ? null : 0, romi: null, visits: 0, clicks: 0,
        clicksByTarget: {}, external: null, externalCapturedAt: null,
      });
    }
    return groups.get(key);
  };
  for (const row of leadRows) {
    const group = groupFor(row.source);
    group.leads += 1;
    const rank = STAGE_RANK.get(row.stage);
    if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('записан')) group.booked += 1;
    if (row.stage !== 'отказ' && rank >= STAGE_RANK.get('пришёл')) group.visited += 1;
    if (row.stage === 'продажа') group.sales += 1;
    if (row.sale_amount !== null) group.revenue += row.sale_amount;
  }
  const filters = ['created_at >= ?'];
  const params = [from];
  if (to) {
    filters.push('created_at <= ?');
    params.push(to);
  }
  if (companyCode) {
    filters.push('company_code = ? COLLATE NOCASE');
    params.push(companyCode);
  }
  if (selectedSource) {
    filters.push('source = ?');
    params.push(selectedSource);
  }
  const eventRows = db.prepare(`
    SELECT source, type, target, client_id FROM events WHERE ${filters.join(' AND ')}
  `).all(...params);
  const visitors = new Map();
  for (const row of eventRows) {
    const group = groupFor(row.source);
    if (row.type === 'visit' && row.client_id) {
      if (!visitors.has(group.source)) visitors.set(group.source, new Set());
      visitors.get(group.source).add(row.client_id);
    }
    if (row.type === 'click') {
      group.clicks += 1;
      const target = row.target || 'unknown';
      group.clicksByTarget[target] = (group.clicksByTarget[target] || 0) + 1;
    }
  }
  for (const [source, clients] of visitors) groupFor(source).visits = clients.size;
  const dateFrom = MOSCOW_DATE.format(new Date(from));
  const dateTo = MOSCOW_DATE.format(to ? new Date(to) : new Date());
  const externalFilters = ['date >= ?', 'date <= ?'];
  const externalParams = [dateFrom, dateTo];
  if (companyCode) {
    externalFilters.push('company_code = ? COLLATE NOCASE');
    externalParams.push(companyCode);
  }
  if (selectedSource) {
    externalFilters.push('source = ?');
    externalParams.push(selectedSource);
  }
  const externalRows = db.prepare(`
    SELECT source, metrics, captured_at FROM external_stats
    WHERE ${externalFilters.join(' AND ')}
  `).all(...externalParams);
  for (const row of externalRows) {
    const group = groupFor(row.source);
    group.external ||= {};
    for (const [key, value] of Object.entries(JSON.parse(row.metrics))) {
      group.external[key] = (group.external[key] || 0) + value;
    }
    if (!group.externalCapturedAt || row.captured_at > group.externalCapturedAt) {
      group.externalCapturedAt = row.captured_at;
    }
  }
  return { groups, groupFor };
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin || (!ALLOWED_ORIGINS.has('*') && !ALLOWED_ORIGINS.has(origin))) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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

function relationRows(kind, id) {
  if (kind === 'tasks') return {};
  if (kind === 'contacts') return {
    companies: db.prepare(`SELECT c.*, r.role, r.is_responsible, r.valid_from, r.valid_to, r.notes relation_notes
      FROM contact_companies r JOIN companies c ON c.id=r.company_id
      WHERE r.contact_id=? AND r.is_deleted=0 AND c.is_deleted=0`).all(id).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.companies, row, true), relation: relationData(row, 'is_responsible') })),
    legalEntities: db.prepare(`SELECT l.*, r.role, r.is_signatory, r.signing_basis, r.valid_from, r.valid_to,
      r.notes relation_notes FROM contact_legal_entities r JOIN legal_entities l ON l.id=r.legal_entity_id
      WHERE r.contact_id=? AND r.is_deleted=0 AND l.is_deleted=0`).all(id).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.legalEntities, row, true),
        relation: relationData(row, 'is_signatory', 'signing_basis') })),
  };
  if (kind === 'companies') {
    const contacts = db.prepare(`SELECT c.*, r.role, r.is_responsible, r.valid_from, r.valid_to, r.notes relation_notes
      FROM contact_companies r JOIN contacts c ON c.id=r.contact_id
      WHERE r.company_id=? AND r.is_deleted=0 AND c.is_deleted=0`).all(id).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.contacts, row, true), relation: relationData(row, 'is_responsible') }));
    const legalEntities = db.prepare(`SELECT l.*, r.role, r.is_primary, r.valid_from, r.valid_to, r.notes relation_notes
      FROM company_legal_entities r JOIN legal_entities l ON l.id=r.legal_entity_id
      WHERE r.company_id=? AND r.is_deleted=0 AND l.is_deleted=0`).all(id).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.legalEntities, row, true), relation: relationData(row, 'is_primary') }));
    const code = db.prepare('SELECT code FROM companies WHERE id=?').get(id).code;
    const leadRows = db.prepare(
      'SELECT stage, COUNT(*) count FROM leads WHERE company_code=? GROUP BY stage'
    ).all(code);
    return { contacts, responsibleContact: contacts.find((item) => item.relation.isResponsible) || null,
      legalEntities, primaryLegalEntity: legalEntities.find((item) => item.relation.isPrimary) || null,
      leadsCount: leadRows.reduce((sum, row) => sum + row.count, 0),
      leadsByStage: Object.fromEntries(leadRows.map((row) => [row.stage, row.count])) };
  }
  return {
    companies: db.prepare(`SELECT c.*, r.role, r.is_primary, r.valid_from, r.valid_to, r.notes relation_notes
      FROM company_legal_entities r JOIN companies c ON c.id=r.company_id
      WHERE r.legal_entity_id=? AND r.is_deleted=0 AND c.is_deleted=0`).all(id).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.companies, row, true), relation: relationData(row, 'is_primary') })),
    contacts: db.prepare(`SELECT c.*, r.role, r.is_signatory, r.signing_basis, r.valid_from, r.valid_to,
      r.notes relation_notes FROM contact_legal_entities r JOIN contacts c ON c.id=r.contact_id
      WHERE r.legal_entity_id=? AND r.is_deleted=0 AND c.is_deleted=0`).all(id).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.contacts, row, true),
        relation: relationData(row, 'is_signatory', 'signing_basis') })),
  };
}
function relationData(row, booleanColumn, extraColumn) {
  const names = { is_responsible: 'isResponsible', is_primary: 'isPrimary',
    is_signatory: 'isSignatory' };
  const boolName = names[booleanColumn];
  return { role: row.role, [boolName]: Boolean(row[booleanColumn]),
    ...(extraColumn ? { signingBasis: row[extraColumn] } : {}), validFrom: row.valid_from,
    validTo: row.valid_to, notes: row.relation_notes };
}
function taskListQuery(url) {
  const deleted = url.searchParams.get('deleted') || 'exclude';
  if (!['exclude', 'include', 'only'].includes(deleted)) {
    fail(400, 'Некорректный deleted', { code: 'VALIDATION_ERROR', field: 'deleted' });
  }
  const limit = Number(url.searchParams.get('limit') || 50);
  const offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 ||
      !Number.isInteger(offset) || offset < 0) {
    fail(400, 'Некорректная пагинация', { code: 'VALIDATION_ERROR' });
  }
  const clauses = deleted === 'exclude' ? ['e.is_deleted=0'] :
    deleted === 'only' ? ['e.is_deleted=1'] : [];
  const params = [];
  const filters = { companyCode: 'company_code', status: 'status',
    assigneeRole: 'assignee_role', source: 'source' };
  for (const [query, field] of Object.entries(filters)) {
    if (!url.searchParams.has(query)) continue;
    clauses.push(`e.${field} = ?${query === 'companyCode' ? ' COLLATE NOCASE' : ''}`);
    params.push(url.searchParams.get(query));
  }
  const q = url.searchParams.get('q');
  if (q) {
    clauses.push('(e.title LIKE ? OR e.description LIKE ? OR e.source_author LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) total FROM tasks e${where}`).get(...params).total;
  const order = `CASE e.status WHEN 'inbox' THEN 0 ELSE 1 END,
    CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
    CASE WHEN e.due_date = '' THEN 1 ELSE 0 END, e.due_date, e.created_at DESC`;
  const rows = db.prepare(`SELECT e.* FROM tasks e${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { rows, pagination: { limit, offset, total } };
}

function listQuery(config, url) {
  if (config.table === 'tasks') return taskListQuery(url);
  const deleted = url.searchParams.get('deleted') || 'exclude';
  if (!['exclude', 'include', 'only'].includes(deleted)) fail(400, 'Некорректный deleted',
    { code: 'VALIDATION_ERROR', field: 'deleted' });
  const limit = Number(url.searchParams.get('limit') || 50);
  const offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
    fail(400, 'Некорректная пагинация', { code: 'VALIDATION_ERROR' });
  }
  const clauses = deleted === 'exclude' ? ['e.is_deleted=0'] : deleted === 'only' ? ['e.is_deleted=1'] : [];
  const params = [];
  const q = url.searchParams.get('q');
  if (q) {
    const alternate = config.table === 'companies' ? 'e.code LIKE ?' : 'e.email LIKE ?';
    clauses.push(`(e.name LIKE ? OR ${alternate})`);
    params.push(`%${q}%`, `%${q}%`); }
  const simple = config.table === 'contacts' ? { city: 'city', preferredChannel: 'preferred_channel' } :
    config.table === 'companies' ? { city: 'city', pipelineStage: 'pipeline_stage' } : { legalForm: 'legal_form' };
  for (const [query, col] of Object.entries(simple)) if (url.searchParams.has(query)) {
    clauses.push(`e.${col}=?`); params.push(url.searchParams.get(query));
  }
  const relationFilters = config.table === 'contacts' ? { companyId: ['contact_companies', 'contact_id', 'company_id'],
    legalEntityId: ['contact_legal_entities', 'contact_id', 'legal_entity_id'] } : config.table === 'companies' ?
    { contactId: ['contact_companies', 'company_id', 'contact_id'],
      legalEntityId: ['company_legal_entities', 'company_id', 'legal_entity_id'] } :
    { contactId: ['contact_legal_entities', 'legal_entity_id', 'contact_id'],
      companyId: ['company_legal_entities', 'legal_entity_id', 'company_id'] };
  for (const [query, [table, own, other]] of Object.entries(relationFilters)) if (url.searchParams.has(query)) {
    clauses.push(`EXISTS(SELECT 1 FROM ${table} r WHERE r.${own}=e.id AND r.${other}=? AND r.is_deleted=0)`);
    params.push(entityId(url.searchParams.get(query)));
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) total FROM ${config.table} e${where}`).get(...params).total;
  const rows = db.prepare(`SELECT e.* FROM ${config.table} e${where} ORDER BY e.name, e.id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { rows, pagination: { limit, offset, total } };
}
async function handleEntityRoutes(request, response, url, cors) {
  for (const [kind, config] of Object.entries(ENTITY_CONFIG)) {
    if (url.pathname === `/${config.path}` && request.method === 'GET') {
      const result = listQuery(config, url);
      send(response, 200, { [config.response]: result.rows.map((row) => serializeEntity(config, row, true)),
        pagination: result.pagination }, cors); return true;
    }
    if (url.pathname === `/${config.path}` && request.method === 'POST') {
      const body = await readJson(request); let values = validateEntity(config, body);
      if (config.table === 'tasks') {
        values = { ...config.defaults, ...values };
        if (values.sourceRef) {
          const duplicate = db.prepare(
            'SELECT * FROM tasks WHERE source_ref = ? AND is_deleted = 0 ORDER BY id LIMIT 1'
          ).get(values.sourceRef);
          if (duplicate) {
            send(response, 200, { ...serializeEntity(config, duplicate), duplicate: true }, cors);
            return true;
          }
        }
      }
      const now = new Date().toISOString();
      const entries = Object.entries(values); const cols = entries.map(([field]) => column(config, field));
      if (config.table === 'contacts' && values.phone !== undefined) { cols.push('normalized_phone');
        entries.push(['normalizedPhone', values.phone ? normalizeContact(values.phone) : null]); }
      try {
        const result = db.prepare(`INSERT INTO ${config.table} (created_at,updated_at,${cols.join(',')})
          VALUES (?,?,${cols.map(() => '?').join(',')})`).run(now, now, ...entries.map(([, value]) => value));
        const id = Number(result.lastInsertRowid); send(response, 201, serializeEntity(config, entityRow(config, id)),
          { ...cors, Location: `/${config.path}/${id}` }); return true;
      } catch (error) { conflict(error); }
    }
    const match = url.pathname.match(new RegExp(`^/${config.path}/(\\d+)$`));
    if (match && request.method === 'GET') {
      const id = entityId(match[1]);
      const includeDeleted = url.searchParams.get('includeDeleted') === 'true';
      const row = entityRow(config, id, includeDeleted);
      send(response, 200, { ...serializeEntity(config, row), ...relationRows(kind, id) }, cors); return true;
    }
    if (match && request.method === 'PATCH') {
      const id = entityId(match[1]); const row = entityRow(config, id, true);
      if (row.is_deleted) fail(409, 'Сначала восстановите удалённую карточку', { code: 'DELETED_ENTITY' });
      const values = validateEntity(config, await readJson(request), true, row); const entries = Object.entries(values);
      const assignments = entries.map(([field]) => `${column(config, field)}=?`);
      const parameters = entries.map(([, value]) => value);
      if (config.table === 'contacts' && values.phone !== undefined) { assignments.push('normalized_phone=?');
        parameters.push(values.phone ? normalizeContact(values.phone) : null); }
      const now = new Date().toISOString();
      const run = () => db.prepare(`UPDATE ${config.table} SET ${assignments.join(',')},updated_at=? WHERE id=?`)
        .run(...parameters, now, id);
      try {
        if (config.table === 'companies' && values.code !== undefined) { db.exec('BEGIN IMMEDIATE');
          try { run(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } } else run();
      } catch (error) { conflict(error); }
      send(response, 200, serializeEntity(config, entityRow(config, id)), cors); return true;
    }
    if (match && request.method === 'DELETE') {
      const id = entityId(match[1]); const row = entityRow(config, id, true);
      if (!row.is_deleted) { const now = new Date().toISOString(); db.exec('BEGIN IMMEDIATE'); try {
        db.prepare(`UPDATE ${config.table} SET is_deleted=1,deleted_at=?,updated_at=? WHERE id=?`).run(now, now, id);
        const updates = config.table === 'tasks' ? [] : config.table === 'contacts' ?
          [['contact_companies', 'contact_id'], ['contact_legal_entities', 'contact_id']] :
          config.table === 'companies' ?
            [['contact_companies', 'company_id'], ['company_legal_entities', 'company_id']] :
            [['company_legal_entities','legal_entity_id'],['contact_legal_entities','legal_entity_id']];
        for (const [table, col] of updates) db.prepare(`UPDATE ${table} SET is_deleted=1,deleted_at=?,updated_at=?
          WHERE ${col}=? AND is_deleted=0`).run(now, now, id); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; } }
      const deleted = entityRow(config, id, true); send(response, 200,
        { id, isDeleted: true, deletedAt: deleted.deleted_at }, cors); return true;
    }
    const restore = url.pathname.match(new RegExp(`^/${config.path}/(\\d+)/restore$`));
    if (restore && request.method === 'POST') { const id = entityId(restore[1]); entityRow(config, id, true);
      try { db.prepare(`UPDATE ${config.table} SET is_deleted=0,deleted_at=NULL,updated_at=? WHERE id=?`)
        .run(new Date().toISOString(), id); } catch (error) { conflict(error); }
      send(response, 200, serializeEntity(config, entityRow(config, id)), cors); return true; }
  }
  return false;
}

const RELATIONS = [
  { regex: /^\/contacts\/(\d+)\/companies\/(\d+)$/, table: 'contact_companies', left: 'contacts',
    right: 'companies', leftCol: 'contact_id', rightCol: 'company_id',
    bool: 'is_responsible', boolJson: 'isResponsible' },
  { regex: /^\/companies\/(\d+)\/legal-entities\/(\d+)$/, table: 'company_legal_entities', left: 'companies',
    right: 'legalEntities', leftCol: 'company_id', rightCol: 'legal_entity_id',
    bool: 'is_primary', boolJson: 'isPrimary' },
  { regex: /^\/contacts\/(\d+)\/legal-entities\/(\d+)$/, table: 'contact_legal_entities', left: 'contacts',
    right: 'legalEntities', leftCol: 'contact_id', rightCol: 'legal_entity_id', bool: 'is_signatory',
    boolJson: 'isSignatory', extra: 'signing_basis', extraJson: 'signingBasis' },
];
async function handleRelationRoutes(request, response, url, cors) {
  for (const relation of RELATIONS) {
    const match = url.pathname.match(relation.regex); if (!match) continue;
    const leftId = entityId(match[1]); const rightId = entityId(match[2]);
    const left = entityRow(ENTITY_CONFIG[relation.left], leftId, true);
    const right = entityRow(ENTITY_CONFIG[relation.right], rightId, true);
    if (request.method === 'PUT') {
      if (left.is_deleted || right.is_deleted) fail(409, 'Нельзя связать удалённую карточку',
        { code: 'DELETED_ENTITY' });
      const body = await readJson(request); const allowed = ['role', relation.boolJson, relation.extraJson,
        'validFrom', 'validTo', 'notes'].filter(Boolean);
      if (Object.keys(body).some((key) => !allowed.includes(key))) fail(400, 'Неизвестное поле связи',
        { code: 'VALIDATION_ERROR' });
      if (body[relation.boolJson] !== undefined && typeof body[relation.boolJson] !== 'boolean') {
        fail(400, `Поле «${relation.boolJson}» должно быть boolean`, { code: 'VALIDATION_ERROR' });
      }
      const old = db.prepare(`SELECT * FROM ${relation.table} WHERE ${relation.leftCol}=? AND ${relation.rightCol}=?`)
        .get(leftId, rightId);
      if ((!old || old.is_deleted) && !body.role) fail(400, 'Для новой связи поле «role» обязательно',
        { code: 'VALIDATION_ERROR', field: 'role' });
      const values = { role: body.role === undefined ? old.role : checkedString(body.role, 'role', false),
        flag: body[relation.boolJson] === undefined ? Boolean(old?.[relation.bool]) : body[relation.boolJson],
        extra: relation.extra ? (body[relation.extraJson] === undefined ? old?.[relation.extra] || null :
          checkedString(body[relation.extraJson], relation.extraJson)) : null,
        validFrom: body.validFrom === undefined ? old?.valid_from || null : body.validFrom === null ? null :
          date(body.validFrom, 'validFrom'), validTo: body.validTo === undefined ? old?.valid_to || null :
          body.validTo === null ? null : date(body.validTo, 'validTo'),
        notes: body.notes === undefined ? old?.notes || null : checkedString(body.notes, 'notes') };
      const now = new Date().toISOString(); db.exec('BEGIN IMMEDIATE'); try {
        if (values.flag && relation.bool !== 'is_signatory') db.prepare(`UPDATE ${relation.table}
          SET ${relation.bool}=0,updated_at=?
          WHERE ${relation.left === 'contacts' ? relation.rightCol : relation.leftCol}=?
          AND is_deleted=0`).run(now, relation.left === 'contacts' ? rightId : leftId);
        if (old) db.prepare(`UPDATE ${relation.table}
          SET role=?,${relation.bool}=?,${relation.extra ? `${relation.extra}=?,` : ''}
          valid_from=?,valid_to=?,notes=?,is_deleted=0,deleted_at=NULL,updated_at=? WHERE id=?`)
          .run(values.role, Number(values.flag), ...(relation.extra ? [values.extra] : []),
            values.validFrom, values.validTo,
            values.notes, now, old.id);
        else db.prepare(`INSERT INTO ${relation.table}
          (created_at,updated_at,${relation.leftCol},${relation.rightCol},role,
          ${relation.bool},${relation.extra ? `${relation.extra},` : ''}valid_from,valid_to,notes) VALUES (?,?,?,?,?,?,
          ${relation.extra ? '?,' : ''}?,?,?)`).run(now, now, leftId, rightId, values.role, Number(values.flag),
            ...(relation.extra ? [values.extra] : []), values.validFrom, values.validTo, values.notes);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      send(response, old ? 200 : 201, { role: values.role, [relation.boolJson]: values.flag,
        ...(relation.extra ? { [relation.extraJson]: values.extra } : {}), validFrom: values.validFrom,
        validTo: values.validTo, notes: values.notes }, cors); return true;
    }
    if (request.method === 'DELETE') {
      const old = db.prepare(`SELECT * FROM ${relation.table} WHERE ${relation.leftCol}=? AND ${relation.rightCol}=?`)
        .get(leftId, rightId); if (!old) fail(404, 'Связь не найдена', { code: 'NOT_FOUND' });
      if (!old.is_deleted) { const now = new Date().toISOString(); db.prepare(`UPDATE ${relation.table}
        SET is_deleted=1,deleted_at=?,updated_at=? WHERE id=?`).run(now, now, old.id); }
      const row = db.prepare(`SELECT * FROM ${relation.table} WHERE id=?`).get(old.id);
      send(response, 200, { id: row.id, isDeleted: true, deletedAt: row.deleted_at }, cors); return true;
    }
  }
  return false;
}

function taskSummary(url) {
  const companyCode = url.searchParams.get('companyCode');
  const clauses = ['is_deleted = 0'];
  const params = [];
  if (companyCode !== null) {
    clauses.push('company_code = ? COLLATE NOCASE');
    params.push(companyCode);
  }
  const where = clauses.join(' AND ');
  const rows = db.prepare(
    `SELECT company_code, status, COUNT(*) count FROM tasks WHERE ${where}
      GROUP BY company_code, status`
  ).all(...params);
  const summary = { inbox: 0, planned: 0, inProgress: 0, done: 0, byCompany: {} };
  for (const row of rows) {
    if (row.status === 'inbox') summary.inbox += row.count;
    if (row.status === 'planned') summary.planned += row.count;
    if (row.status === 'in_progress') summary.inProgress += row.count;
    if (row.status === 'done') summary.done += row.count;
    if (!row.company_code) continue;
    summary.byCompany[row.company_code] ||= { inbox: 0, open: 0 };
    if (row.status === 'inbox') summary.byCompany[row.company_code].inbox += row.count;
    if (['inbox', 'planned', 'in_progress'].includes(row.status)) {
      summary.byCompany[row.company_code].open += row.count;
    }
  }
  return summary;
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    return response.end();
  }
  takeRateLimit(request);
  const publicPost = request.method === 'POST' && ['/leads', '/events'].includes(url.pathname);
  if (!publicPost) requireApiKey(request);

  if (await handleRelationRoutes(request, response, url, cors)) return;
  if (request.method === 'GET' && url.pathname === '/tasks/summary') {
    return send(response, 200, taskSummary(url), cors);
  }
  if (await handleEntityRoutes(request, response, url, cors)) return;

  if (request.method === 'POST' && url.pathname === '/events') {
    const body = await readJson(request);
    const type = limitedString(body.type, 'type', true);
    if (!['visit', 'click'].includes(type)) {
      fail(400, 'Поле «type» должно быть равно visit или click');
    }
    const companyCode = activeCompanyCode(body.companyCode);
    const fields = {};
    for (const field of ['clientId', 'page', 'landingPage', 'referrer', 'utmSource', 'utmMedium',
      'utmCampaign', 'utmContent', 'utmTerm', 'source', 'target', 'label']) {
      fields[field] = limitedString(body[field], field);
    }
    const createdAt = body.ts === undefined ? new Date().toISOString() :
      date(limitedString(body.ts, 'ts', true), 'ts');
    const derived = deriveSource({ utmSource: fields.utmSource, referrer: fields.referrer });
    const source = (['direct', 'unknown'].includes(derived) && fields.source
      ? fields.source.toLowerCase() : derived);
    if (type === 'visit' && fields.clientId) {
      const duplicate = db.prepare(`
        SELECT 1 FROM events WHERE type='visit' AND company_code=? COLLATE NOCASE
          AND client_id=? AND page IS ? AND created_at>=? AND created_at<=? LIMIT 1
      `).get(companyCode, fields.clientId, fields.page,
        new Date(new Date(createdAt).getTime() - 30 * 60 * 1000).toISOString(),
        new Date(new Date(createdAt).getTime() + 30 * 60 * 1000).toISOString());
      if (duplicate) return send(response, 202, { ok: true }, cors);
    }
    const userAgent = String(request.headers['user-agent'] || '').slice(0, 60) || null;
    insertEvent.run(
      createdAt, type, companyCode, fields.clientId, fields.page, fields.landingPage,
      fields.referrer, fields.utmSource, fields.utmMedium, fields.utmCampaign,
      fields.utmContent, fields.utmTerm, source, fields.target, fields.label,
      requestIpHash(request), userAgent
    );
    return send(response, 202, { ok: true }, cors);
  }

  if (request.method === 'POST' && url.pathname === '/external-stats') {
    const body = await readJson(request);
    const source = limitedString(body.source, 'source', true).toLowerCase();
    const companyCode = activeCompanyCode(body.companyCode);
    const note = limitedString(body.note, 'note');
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      fail(400, 'Поле «rows» должно быть непустым массивом');
    }
    const rows = body.rows.map((row, index) => {
      if (!row || Array.isArray(row) || typeof row !== 'object') {
        fail(400, `Строка rows[${index}] должна быть объектом`);
      }
      const day = validDay(row.date, `rows[${index}].date`);
      const metrics = {};
      for (const [key, value] of Object.entries(row)) {
        if (key === 'date') continue;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          fail(400, `Метрика «${key}» должна быть числом`);
        }
        metrics[key] = value;
      }
      return { day, metrics };
    });
    const capturedAt = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        upsertExternalStat.run(
          source, companyCode, row.day, JSON.stringify(row.metrics), capturedAt, note
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const dates = rows.map((row) => row.day).sort();
    return send(response, 200, {
      ok: true, upserted: rows.length, source, companyCode,
      dates: [dates[0], dates[dates.length - 1]],
    }, cors);
  }

  if (request.method === 'GET' && url.pathname === '/external-stats') {
    const clauses = [];
    const params = [];
    let fromDay = null;
    let toDay = null;
    if (url.searchParams.has('source')) {
      clauses.push('source = ?');
      params.push(limitedString(url.searchParams.get('source'), 'source', true).toLowerCase());
    }
    if (url.searchParams.has('companyCode')) {
      clauses.push('company_code = ? COLLATE NOCASE');
      params.push(limitedString(url.searchParams.get('companyCode'), 'companyCode', true).toLowerCase());
    }
    for (const [parameter, operator] of [['from', '>='], ['to', '<=']]) {
      if (!url.searchParams.has(parameter)) continue;
      clauses.push(`date ${operator} ?`);
      const day = validDay(url.searchParams.get(parameter), parameter);
      if (parameter === 'from') fromDay = day;
      else toDay = day;
      params.push(day);
    }
    if (fromDay && toDay && fromDay > toDay) fail(400, 'Дата «from» не может быть позже «to»');
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT * FROM external_stats${where} ORDER BY date, source, company_code
    `).all(...params).map((row) => ({
      id: row.id, source: row.source, companyCode: row.company_code, date: row.date,
      metrics: JSON.parse(row.metrics), capturedAt: row.captured_at, note: row.note,
    }));
    const capturedAt = rows.reduce((latest, row) => {
      return !latest || row.capturedAt > latest ? row.capturedAt : latest;
    }, null);
    return send(response, 200, { rows, capturedAt }, cors);
  }

  if (request.method === 'GET' && url.pathname === '/dashboard') {
    const customRange = url.searchParams.has('from') || url.searchParams.has('to');
    if (customRange && (!url.searchParams.has('from') || !url.searchParams.has('to'))) {
      fail(400, 'Для диапазона нужны обе даты: «from» и «to»');
    }
    const from = customRange
      ? rangeDate(url.searchParams.get('from'), 'from')
      : cabinetPeriod(url.searchParams.get('period') || 'today');
    const to = customRange ? rangeDate(url.searchParams.get('to'), 'to', true) : null;
    if (to && from > to) fail(400, 'Дата «from» не может быть позже «to»');
    const requestedStage = url.searchParams.get('stage');
    const stage = requestedStage ? CABINET_STAGES.get(requestedStage) : null;
    if (requestedStage && !stage) fail(400, 'Неизвестный этап', { allowed: [...CABINET_STAGES.keys()] });
    const source = url.searchParams.get('source');
    const companyCode = url.searchParams.get('companyCode');
    const clauses = ['created_at >= ?'];
    const params = [from];
    if (to) {
      clauses.push('created_at <= ?');
      params.push(to);
    }
    if (stage) {
      clauses.push('stage = ?');
      params.push(stage);
    }
    if (source) {
      clauses.push('source = ?');
      params.push(source);
    }
    if (companyCode) {
      clauses.push('company_code = ? COLLATE NOCASE');
      params.push(companyCode);
    }
    const rows = db.prepare(
      `SELECT * FROM leads WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
    ).all(...params);
    const analytics = analyticsData(from, to, companyCode, source, rows);
    if (!companyCode) {
      const expenseFilters = ['spent_at >= ?'];
      const expenseParams = [from];
      if (to) {
        expenseFilters.push('spent_at <= ?');
        expenseParams.push(to);
      }
      if (source) {
        expenseFilters.push('source = ?');
        expenseParams.push(source);
      }
      const expenseRows = db.prepare(`
        SELECT source, SUM(amount) expenses FROM expenses
        WHERE ${expenseFilters.join(' AND ')} GROUP BY source
      `).all(...expenseParams);
      for (const row of expenseRows) analytics.groupFor(row.source).expenses = row.expenses;
      for (const group of analytics.groups.values()) {
        group.romi = romi(group.revenue, group.expenses);
      }
    }
    const sources = [...analytics.groups.values()]
      .sort((a, b) => a.source.localeCompare(b.source, 'ru'));
    const funnel = Object.fromEntries([...CABINET_STAGES].map(([id, name]) => {
      const count = rows.filter((row) => row.stage === name).length;
      return [id, { count, conversion: rows.length ? Math.round((count / rows.length) * 100) : 0 }];
    }));
    const revenue = rows.reduce((total, row) => total + (row.sale_amount || 0), 0);
    const expenses = companyCode ? null : totalExpense(from, to, source);
    return send(response, 200, {
      sample: false,
      companyCode: companyCode || null,
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
        romi: companyCode ? null : romi(revenue, expenses),
        visits: sources.reduce((sum, item) => sum + item.visits, 0),
        clicks: sources.reduce((sum, item) => sum + item.clicks, 0),
      },
      funnel,
      leads: rows.map(serializeCabinetLead),
      sources,
      ...(companyCode ? { expensesScope: 'global_unavailable' } : {}),
    }, cors);
  }

  if (request.method === 'POST' && url.pathname === '/leads') {
    const body = await readJson(request);
    const contact = requiredString(body.contact, 'contact');
    const normalized = normalizeContact(contact);
    const companyCode = body.companyCode === undefined || body.companyCode === null ? null :
      requiredString(body.companyCode, 'companyCode').toLowerCase();
    if (companyCode) {
      const company = db.prepare('SELECT * FROM companies WHERE code = ? COLLATE NOCASE').get(companyCode);
      if (!company || company.is_deleted) fail(409, 'Активная компания с таким кодом не найдена',
        { code: 'COMPANY_NOT_ACTIVE', field: 'companyCode' });
    }
    const duplicate = getLeadByContact.get(normalized, companyCode);
    if (duplicate) return send(response, 200, { ...serializeLead(duplicate), deduplicated: true }, cors);
    const utmSource = optionalString(body.utmSource, 'utmSource');
    const referrer = optionalString(body.referrer, 'referrer');
    const sourceInput = optionalString(body.source, 'source');
    const derived = deriveSource({ utmSource, referrer });
    const source = sourceInput || (utmSource ? derived : (derived === 'direct' ? null : derived));
    const landingPage = optionalString(body.landingPage, 'landingPage');
    const result = createLead.run(
      new Date().toISOString(),
      requiredString(body.name, 'name'),
      contact,
      normalized,
      optionalString(body.channel, 'channel'),
      source,
      optionalString(body.tag, 'tag'),
      optionalString(body.page, 'page') || landingPage,
      optionalString(body.firstQuestion, 'firstQuestion'),
      optionalString(body.comment, 'comment'),
      utmSource,
      optionalString(body.utmMedium, 'utmMedium'),
      optionalString(body.utmCampaign, 'utmCampaign'),
      optionalString(body.utmContent, 'utmContent'),
      optionalString(body.utmTerm, 'utmTerm'),
      optionalString(body.clientId, 'clientId'),
      referrer,
      landingPage,
      companyCode
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
    if (url.searchParams.has('companyCode')) {
      const companyCode = url.searchParams.get('companyCode');
      clauses.push(companyCode === '' ? 'company_code IS NULL' : 'company_code = ? COLLATE NOCASE');
      if (companyCode !== '') params.push(companyCode);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM leads${where} ORDER BY created_at DESC, id DESC`).all(...params);
    return send(response, 200, { leads: rows.map(serializeLead) }, cors);
  }

  if (request.method === 'GET' && url.pathname === '/leads.csv') {
    const companyCode = url.searchParams.get('companyCode');
    const companyClause = companyCode ? ' WHERE company_code = ? COLLATE NOCASE' : '';
    const rows = db.prepare(`SELECT * FROM leads${companyClause} ORDER BY created_at DESC, id DESC`)
      .all(...(companyCode ? [companyCode] : []));
    const fields = ['id', 'created_at', 'name', 'contact', 'channel', 'source', 'tag', 'page', 'stage',
      'sale_amount', 'sold_at', 'comment', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
      'utm_term', 'client_id', 'referrer', 'landing_page', 'company_code'];
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
    if (url.searchParams.has('companyCode')) {
      return send(response, 200, { expenses: [], expensesScope: 'global_unavailable' }, cors);
    }
    const from = url.searchParams.has('from') ? rangeDate(url.searchParams.get('from'), 'from') : null;
    const to = url.searchParams.has('to') ? rangeDate(url.searchParams.get('to'), 'to', true) : null;
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
    if (body.companyCode !== undefined) {
      const companyCode = body.companyCode === null ? null :
        requiredString(body.companyCode, 'companyCode').toLowerCase();
      if (companyCode) {
        const company = db.prepare('SELECT * FROM companies WHERE code=? COLLATE NOCASE').get(companyCode);
        if (!company || company.is_deleted) fail(409, 'Активная компания с таким кодом не найдена',
          { code: 'COMPANY_NOT_ACTIVE', field: 'companyCode' });
      }
      db.prepare('UPDATE leads SET company_code=? WHERE id=?').run(companyCode, row.id);
    } else if (body.stage !== undefined) {
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
    const from = rangeDate(url.searchParams.get('from'), 'from');
    const to = rangeDate(url.searchParams.get('to'), 'to', true);
    if (from > to) fail(400, 'Дата «from» не может быть позже «to»');
    const companyCode = url.searchParams.get('companyCode');
    const companyClause = companyCode ? ' AND company_code = ? COLLATE NOCASE' : '';
    const companyParams = companyCode ? [companyCode] : [];
    const rows = db.prepare(`
      SELECT source, stage, sale_amount FROM leads
      WHERE created_at >= ? AND created_at <= ?${companyClause}
    `).all(from, to, ...companyParams);
    const expenseRows = companyCode ? [] : db.prepare(`
      SELECT source, SUM(amount) AS expenses FROM expenses
      WHERE spent_at >= ? AND spent_at <= ? GROUP BY source
    `).all(from, to);
    const analytics = analyticsData(from, to, companyCode, null, rows);
    for (const row of expenseRows) analytics.groupFor(row.source).expenses = row.expenses;
    if (!companyCode) {
      for (const group of analytics.groups.values()) group.romi = romi(group.revenue, group.expenses);
    }
    const sources = [...analytics.groups.values()]
      .sort((a, b) => a.source.localeCompare(b.source, 'ru'));
    const revenue = sources.reduce((sum, group) => sum + group.revenue, 0);
    const expenses = companyCode ? null : sources.reduce((sum, group) => sum + group.expenses, 0);
    return send(response, 200, {
      from, to, revenue, expenses, romi: companyCode ? null : romi(revenue, expenses), sources,
      visits: sources.reduce((sum, group) => sum + group.visits, 0),
      clicks: sources.reduce((sum, group) => sum + group.clicks, 0),
      ...(companyCode ? { expensesScope: 'global_unavailable' } : {}),
    }, cors);
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

if (IS_MAIN) {
  server.listen(PORT, () => {
    console.log(`Мини-CRM слушает порт ${PORT}; база: ${DATABASE_PATH}`);
  });
}

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

module.exports = { deriveSource };

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
