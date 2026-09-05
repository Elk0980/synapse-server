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

migrate(4, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id INTEGER PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_final INTEGER DEFAULT 0,
      kind TEXT CHECK(kind IN ('open', 'won', 'lost')) DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const stages = [
    ['new', 'Новый', 'open'],
    ['in_progress', 'В работе', 'open'],
    ['payment', 'Оплата', 'open'],
    ['repeat', 'Повторная продажа', 'won'],
    ['rejected', 'Отказ', 'lost'],
  ];
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pipeline_stages (code, label, position, is_final, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stages.forEach(([code, label, kind], position) => {
    insert.run(code, label, position, Number(kind !== 'open'), kind, now, now);
  });
  db.exec(`
    UPDATE companies SET pipeline_stage = CASE pipeline_stage
      WHEN 'application' THEN 'new'
      WHEN 'call' THEN 'in_progress'
      WHEN 'kit_ready' THEN 'in_progress'
      WHEN 'active' THEN 'repeat'
      ELSE pipeline_stage
    END
    WHERE pipeline_stage IN ('application', 'call', 'kit_ready', 'active');
  `);
});

const PIPELINE_DEFAULTS = {
  sale: [
    ['new', 'Новый', 'open'], ['contact', 'Контакт', 'open'], ['meeting', 'Встреча', 'open'],
    ['pilot', 'Пилот', 'open'], ['paid', 'Оплата', 'won'], ['rejected', 'Отказ', 'lost'],
  ],
  service: [
    ['onboarding', 'Внедрение', 'open'], ['active', 'Активен', 'open'], ['renewal', 'Продление', 'open'],
    ['upsell', 'Доп. продажа', 'open'], ['risk', 'Риск ухода', 'open', true], ['churned', 'Ушёл', 'lost'],
  ],
};

migrate(5, () => {
  const previousStages = db.prepare('SELECT * FROM pipeline_stages ORDER BY position, id').all();
  db.exec(`
    CREATE TABLE pipelines (
      id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, label TEXT NOT NULL, position INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    ALTER TABLE pipeline_stages RENAME TO pipeline_stages_legacy;
    CREATE TABLE pipeline_stages (
      id INTEGER PRIMARY KEY, pipeline_id INTEGER NOT NULL REFERENCES pipelines(id), code TEXT NOT NULL,
      label TEXT NOT NULL, position INTEGER NOT NULL, is_final INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'open' CHECK(kind IN ('open', 'won', 'lost')),
      attention INTEGER NOT NULL DEFAULT 0 CHECK(attention IN (0, 1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(pipeline_id, code)
    );
    CREATE TABLE company_pipeline_state (
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      pipeline_id INTEGER NOT NULL REFERENCES pipelines(id), stage_code TEXT NOT NULL,
      entered_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      return_task_created INTEGER NOT NULL DEFAULT 0 CHECK(return_task_created IN (0, 1)),
      PRIMARY KEY(company_id, pipeline_id),
      FOREIGN KEY(pipeline_id, stage_code) REFERENCES pipeline_stages(pipeline_id, code)
    );
    CREATE TABLE company_stage_history (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      pipeline_code TEXT NOT NULL, from_code TEXT, to_code TEXT, at TEXT NOT NULL,
      by TEXT NOT NULL CHECK(by IN ('auto', 'user')), reason TEXT
    );
    CREATE INDEX company_stage_history_company_idx ON company_stage_history(company_id, at, id);
    CREATE TABLE company_service (
      company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE, paid_until DATE,
      monthly_amount REAL CHECK(monthly_amount IS NULL OR monthly_amount >= 0),
      last_touch_at TEXT, next_touch_at TEXT, client_owner_contact_id INTEGER REFERENCES contacts(id)
    );
    CREATE TABLE pipeline_rules (
      id INTEGER PRIMARY KEY CHECK(id = 1), silent_days INTEGER NOT NULL, renewal_days INTEGER NOT NULL,
      rejected_return_months INTEGER NOT NULL, churned_return_months INTEGER NOT NULL
    );
    INSERT INTO pipeline_rules VALUES (1, 14, 10, 3, 6);
  `);
  const now = new Date().toISOString();
  const insertPipeline = db.prepare(`
    INSERT INTO pipelines (code, label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `);
  insertPipeline.run('sale', 'Продажа', 0, now, now);
  insertPipeline.run('service', 'Сервис', 1, now, now);
  const pipelineIds = Object.fromEntries(db.prepare('SELECT id, code FROM pipelines').all()
    .map((pipeline) => [pipeline.code, pipeline.id]));
  const legacyCodes = new Map([['in_progress', 'contact'], ['payment', 'paid'], ['repeat', 'paid']]);
  const legacyKinds = new Map([['new', 'open'], ['in_progress', 'open'], ['payment', 'open'],
    ['repeat', 'won'], ['rejected', 'lost']]);
  const newCodes = new Set(['contact', 'meeting', 'pilot', 'paid']);
  const reservedCodes = new Set([...previousStages.map((stage) => stage.code),
    ...PIPELINE_DEFAULTS.sale.map((stage) => stage[0])]);
  const renamedCodes = new Map();
  for (const stage of previousStages) {
    if (newCodes.has(stage.code)) renamedCodes.set(stage.code, pipelineStageCode(stage.code, reservedCodes));
  }
  const migratedCode = (code) => renamedCodes.get(code) || legacyCodes.get(code) || code;
  const saleStages = [];
  for (const previous of previousStages) {
    const code = migratedCode(previous.code);
    if (saleStages.some((stage) => stage.code === code)) continue;
    const defaults = PIPELINE_DEFAULTS.sale.find((stage) => stage[0] === code);
    const oldLabel = previous.code === 'in_progress' ? 'В работе' :
      previous.code === 'repeat' ? 'Повторная продажа' : null;
    const kind = defaults && previous.kind === legacyKinds.get(previous.code) ? defaults[2] : previous.kind;
    saleStages.push({ code, label: defaults && previous.label === oldLabel ? defaults[1] : previous.label,
      kind, attention: false });
  }
  for (const [index, [code, label, kind]] of PIPELINE_DEFAULTS.sale.entries()) {
    if (saleStages.some((stage) => stage.code === code)) continue;
    const following = new Set(PIPELINE_DEFAULTS.sale.slice(index + 1).map((stage) => stage[0]));
    const position = saleStages.findIndex((stage) => following.has(stage.code));
    saleStages.splice(position < 0 ? saleStages.length : position, 0, { code, label, kind, attention: false });
  }
  const companies = db.prepare('SELECT id, pipeline_stage FROM companies').all();
  for (const company of companies) {
    const code = migratedCode(company.pipeline_stage);
    if (code && !saleStages.some((stage) => stage.code === code)) {
      saleStages.push({ code, label: code, kind: 'open', attention: false });
    }
  }
  const insertStage = db.prepare(`
    INSERT INTO pipeline_stages
      (pipeline_id, code, label, position, kind, is_final, attention, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const serviceStages = PIPELINE_DEFAULTS.service.map(([code, label, kind, attention = false]) =>
    ({ code, label, kind, attention }));
  for (const [pipeline, stages] of [['sale', saleStages], ['service', serviceStages]]) {
    stages.forEach((stage, position) => insertStage.run(pipelineIds[pipeline], stage.code, stage.label,
      position, stage.kind, Number(stage.kind !== 'open'), Number(stage.attention), now, now));
  }
  const insertState = db.prepare(`
    INSERT INTO company_pipeline_state (company_id, pipeline_id, stage_code, entered_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertHistory = db.prepare(`
    INSERT INTO company_stage_history (company_id, pipeline_code, from_code, to_code, at, by, reason)
    VALUES (?, ?, NULL, ?, ?, 'auto', 'Миграция воронок')
  `);
  for (const company of companies) {
    if (company.pipeline_stage === null) continue;
    const code = migratedCode(company.pipeline_stage);
    insertState.run(company.id, pipelineIds.sale, code, now, now);
    insertHistory.run(company.id, 'sale', code, now);
    db.prepare('UPDATE companies SET pipeline_stage = ? WHERE id = ?').run(code, company.id);
    if (company.pipeline_stage === 'repeat') {
      insertState.run(company.id, pipelineIds.service, 'active', now, now);
      insertHistory.run(company.id, 'service', 'active', now);
    }
  }
  db.exec('DROP TABLE pipeline_stages_legacy');
  const taskObjects = db.prepare(`
    SELECT sql FROM sqlite_master WHERE tbl_name = 'tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL
  `).all();
  const taskSequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get()?.seq || 0;
  const taskSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().sql;
  const expanded = taskSchema.replace(/CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)/i,
    (_, sources) => `CHECK(source IN (${sources}, 'pipeline'))`);
  if (expanded === taskSchema) throw new Error('Не удалось расширить допустимые источники задач');
  db.exec(expanded.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?tasks["`]?/i, 'CREATE TABLE tasks_v5'));
  const taskColumns = [...tableColumns('tasks')].map((name) => `"${name}"`).join(',');
  db.exec(`INSERT INTO tasks_v5 (${taskColumns}) SELECT ${taskColumns} FROM tasks;
    DROP TABLE tasks; ALTER TABLE tasks_v5 RENAME TO tasks;`);
  db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'tasks'").run(taskSequence);
  for (const object of taskObjects) db.exec(object.sql);
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
  if (host === 't.me' || host.endsWith('.t.me') || host.startsWith('telegram.') ||
      host.includes('.telegram.')) return 'telegram';
  if (host === 'wa.me' || host.endsWith('.wa.me') || host.startsWith('whatsapp.') ||
      host.includes('.whatsapp.')) {
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
  source: new Set(['manual', 'chat', 'telegram', 'pipeline']),
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
    if (config.table === 'companies' && key === 'reason' && Object.hasOwn(body, 'pipelineStage')) continue;
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
    if (field === 'pipelineStage' && value !== null) {
      if (!db.prepare(`SELECT 1 FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
        WHERE p.code = 'sale' AND s.code = ?`).get(value)) {
        fail(400, 'Неизвестный этап компании', { code: 'VALIDATION_ERROR', field });
      }
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
  if (config.table === 'companies') Object.assign(result, companyPipelineDetails(row.id));
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
    const key = source || 'direct';
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

function analyticsSources(companyCode) {
  const companyFilter = companyCode ? ' WHERE company_code = ? COLLATE NOCASE' : '';
  const params = companyCode ? [companyCode, companyCode, companyCode] : [];
  return db.prepare(`
    SELECT DISTINCT source FROM (
      SELECT source FROM leads${companyFilter}
      UNION ALL SELECT source FROM events${companyFilter}
      UNION ALL SELECT source FROM external_stats${companyFilter}
    ) WHERE source IS NOT NULL AND source != '' ORDER BY source
  `).all(...params).map((row) => row.source);
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

function scopedCompany(companyCode) {
  if (companyCode === null) return null;
  const company = db.prepare(
    'SELECT * FROM companies WHERE code = ? COLLATE NOCASE AND is_deleted = 0'
  ).get(companyCode);
  if (!company) fail(404, 'Компания не найдена', { code: 'NOT_FOUND' });
  return company;
}

function entityInCompany(config, id, company) {
  if (!company) return;
  let found;
  if (config.table === 'tasks') found = db.prepare(
    'SELECT 1 FROM tasks WHERE id=? AND company_code=? COLLATE NOCASE'
  ).get(id, company.code);
  if (config.table === 'companies') found = id === company.id;
  if (config.table === 'contacts') found = db.prepare(`SELECT 1 FROM contact_companies
    WHERE contact_id=? AND company_id=? AND is_deleted=0`).get(id, company.id);
  if (config.table === 'legal_entities') found = db.prepare(`SELECT 1 FROM company_legal_entities
    WHERE legal_entity_id=? AND company_id=? AND is_deleted=0`).get(id, company.id);
  if (!found) fail(404, 'Карточка не найдена', { code: 'NOT_FOUND' });
}

function relationRows(kind, id, company) {
  if (kind === 'tasks') return {};
  if (kind === 'contacts') return {
    companies: db.prepare(`SELECT c.*, r.role, r.is_responsible, r.valid_from, r.valid_to, r.notes relation_notes
      FROM contact_companies r JOIN companies c ON c.id=r.company_id
      WHERE r.contact_id=? AND r.is_deleted=0 AND c.is_deleted=0
      ${company ? 'AND c.id=?' : ''}`).all(id, ...(company ? [company.id] : [])).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.companies, row, true), relation: relationData(row, 'is_responsible') })),
    legalEntities: db.prepare(`SELECT l.*, r.role, r.is_signatory, r.signing_basis, r.valid_from, r.valid_to,
      r.notes relation_notes FROM contact_legal_entities r JOIN legal_entities l ON l.id=r.legal_entity_id
      WHERE r.contact_id=? AND r.is_deleted=0 AND l.is_deleted=0
      ${company ? `AND EXISTS(SELECT 1 FROM company_legal_entities scope
        WHERE scope.legal_entity_id=l.id AND scope.company_id=? AND scope.is_deleted=0)` : ''}`)
      .all(id, ...(company ? [company.id] : [])).map((row) => ({
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
      WHERE r.legal_entity_id=? AND r.is_deleted=0 AND c.is_deleted=0
      ${company ? 'AND c.id=?' : ''}`).all(id, ...(company ? [company.id] : [])).map((row) => ({
        ...serializeEntity(ENTITY_CONFIG.companies, row, true), relation: relationData(row, 'is_primary') })),
    contacts: db.prepare(`SELECT c.*, r.role, r.is_signatory, r.signing_basis, r.valid_from, r.valid_to,
      r.notes relation_notes FROM contact_legal_entities r JOIN contacts c ON c.id=r.contact_id
      WHERE r.legal_entity_id=? AND r.is_deleted=0 AND c.is_deleted=0
      ${company ? `AND EXISTS(SELECT 1 FROM contact_companies scope
        WHERE scope.contact_id=c.id AND scope.company_id=? AND scope.is_deleted=0)` : ''}`)
      .all(id, ...(company ? [company.id] : [])).map((row) => ({
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
  const companyCode = url.searchParams.get('companyCode');
  if (companyCode !== null) {
    if (config.table === 'companies') {
      clauses.push('e.code = ? COLLATE NOCASE');
      params.push(companyCode);
    } else if (config.table === 'contacts') {
      clauses.push(`EXISTS(SELECT 1 FROM contact_companies scope
        JOIN companies company ON company.id=scope.company_id
        WHERE scope.contact_id=e.id AND scope.is_deleted=0 AND company.is_deleted=0
          AND company.code=? COLLATE NOCASE)`);
      params.push(companyCode);
    } else if (config.table === 'legal_entities') {
      clauses.push(`EXISTS(SELECT 1 FROM company_legal_entities scope
        JOIN companies company ON company.id=scope.company_id
        WHERE scope.legal_entity_id=e.id AND scope.is_deleted=0 AND company.is_deleted=0
          AND company.code=? COLLATE NOCASE)`);
      params.push(companyCode);
    }
  }
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
    const company = scopedCompany(url.searchParams.get('companyCode'));
    if (url.pathname === `/${config.path}` && request.method === 'GET') {
      const result = listQuery(config, url);
      send(response, 200, { [config.response]: result.rows.map((row) => serializeEntity(config, row, true)),
        pagination: result.pagination }, cors); return true;
    }
    if (url.pathname === `/${config.path}` && request.method === 'POST') {
      const body = await readJson(request); let values = validateEntity(config, body);
      if (company && config.table === 'companies' && values.code !== company.code.toLowerCase()) {
        fail(403, 'Нельзя создать другую компанию в выбранном контексте');
      }
      if (config.table === 'tasks') {
        values = { ...config.defaults, ...values };
        if (company) values.companyCode = company.code.toLowerCase();
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
        const insert = () => {
          const result = db.prepare(`INSERT INTO ${config.table} (created_at,updated_at,${cols.join(',')})
            VALUES (?,?,${cols.map(() => '?').join(',')})`).run(now, now, ...entries.map(([, value]) => value));
          const id = Number(result.lastInsertRowid);
          if (config.table === 'companies' && values.pipelineStage !== undefined) {
            changeCompanyPipeline(entityRow(config, id), pipelineRow('sale'), values.pipelineStage,
              body.reason, 'user', now);
          }
          return id;
        };
        const id = config.table === 'companies' ? pipelineTransaction(insert) : insert();
        if (company && ['contacts', 'legal_entities'].includes(config.table)) {
          const relation = config.table === 'contacts'
            ? ['contact_companies', 'contact_id', 'сотрудник']
            : ['company_legal_entities', 'legal_entity_id', 'юрлицо компании'];
          db.prepare(`INSERT INTO ${relation[0]}
            (created_at,updated_at,${relation[1]},company_id,role) VALUES (?,?,?,?,?)`)
            .run(now, now, id, company.id, relation[2]);
        }
        send(response, 201, serializeEntity(config, entityRow(config, id)),
          { ...cors, Location: `/${config.path}/${id}` }); return true;
      } catch (error) { conflict(error); }
    }
    const match = url.pathname.match(new RegExp(`^/${config.path}/(\\d+)$`));
    if (match && request.method === 'GET') {
      const id = entityId(match[1]);
      const includeDeleted = url.searchParams.get('includeDeleted') === 'true';
      const row = entityRow(config, id, includeDeleted);
      entityInCompany(config, id, company);
      send(response, 200, { ...serializeEntity(config, row), ...relationRows(kind, id, company) }, cors); return true;
    }
    if (match && request.method === 'PATCH') {
      const id = entityId(match[1]); const row = entityRow(config, id, true);
      entityInCompany(config, id, company);
      if (row.is_deleted) fail(409, 'Сначала восстановите удалённую карточку', { code: 'DELETED_ENTITY' });
      const body = await readJson(request);
      const values = validateEntity(config, body, true, row); const entries = Object.entries(values);
      if (company && config.table === 'tasks' && values.companyCode !== undefined &&
          values.companyCode !== company.code.toLowerCase()) {
        fail(403, 'Нельзя перенести задачу из выбранной компании');
      }
      const assignments = entries.map(([field]) => `${column(config, field)}=?`);
      const parameters = entries.map(([, value]) => value);
      if (config.table === 'contacts' && values.phone !== undefined) { assignments.push('normalized_phone=?');
        parameters.push(values.phone ? normalizeContact(values.phone) : null); }
      const now = new Date().toISOString();
      const run = () => db.prepare(`UPDATE ${config.table} SET ${assignments.join(',')},updated_at=? WHERE id=?`)
        .run(...parameters, now, id);
      try {
        if (config.table === 'companies') {
          pipelineTransaction(() => {
            run();
            if (values.pipelineStage !== undefined) {
              changeCompanyPipeline(row, pipelineRow('sale'), values.pipelineStage, body.reason, 'user', now);
            }
          });
        } else run();
      } catch (error) { conflict(error); }
      send(response, 200, serializeEntity(config, entityRow(config, id)), cors); return true;
    }
    if (match && request.method === 'DELETE') {
      const id = entityId(match[1]); const row = entityRow(config, id, true);
      entityInCompany(config, id, company);
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
      entityInCompany(config, id, company);
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
  const company = scopedCompany(url.searchParams.get('companyCode'));
  for (const relation of RELATIONS) {
    const match = url.pathname.match(relation.regex); if (!match) continue;
    const leftId = entityId(match[1]); const rightId = entityId(match[2]);
    const left = entityRow(ENTITY_CONFIG[relation.left], leftId, true);
    const right = entityRow(ENTITY_CONFIG[relation.right], rightId, true);
    entityInCompany(ENTITY_CONFIG[relation.left], leftId, company);
    entityInCompany(ENTITY_CONFIG[relation.right], rightId, company);
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

function pipelineList() {
  return db.prepare('SELECT id, code, label, position FROM pipelines ORDER BY position, id').all();
}

function pipelineRow(code = 'sale') {
  const pipeline = typeof code === 'string' && db.prepare('SELECT * FROM pipelines WHERE code = ?').get(code);
  if (!pipeline) fail(400, 'Неизвестная воронка', { code: 'VALIDATION_ERROR', field: 'pipeline' });
  return pipeline;
}

function pipelineStages(code = 'sale') {
  const pipeline = pipelineRow(code);
  const defaults = Object.hasOwn(PIPELINE_DEFAULTS, code) ? PIPELINE_DEFAULTS[code] : [];
  const systemCodes = new Set(defaults.map((stage) => stage[0]));
  return db.prepare(`SELECT id, code, label, position, kind, attention FROM pipeline_stages
    WHERE pipeline_id = ? ORDER BY position, id`).all(pipeline.id).map((stage) =>
    ({ ...stage, attention: Boolean(stage.attention), system: systemCodes.has(stage.code) }));
}

function pipelineTransaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function companyPipelineDetails(companyId) {
  const states = db.prepare(`SELECT p.code, s.stage_code, s.entered_at FROM company_pipeline_state s
    JOIN pipelines p ON p.id = s.pipeline_id WHERE s.company_id = ? ORDER BY p.position, p.id`).all(companyId);
  const service = db.prepare(`SELECT s.*, c.id owner_id, c.name owner_name FROM company_service s
    LEFT JOIN contacts c ON c.id = s.client_owner_contact_id AND c.is_deleted = 0
    WHERE s.company_id = ?`).get(companyId);
  return {
    pipelines: Object.fromEntries(states.map((state) => [state.code,
      { stage: state.stage_code, enteredAt: state.entered_at }])),
    service: {
      paidUntil: service?.paid_until ?? null, monthlyAmount: service?.monthly_amount ?? null,
      lastTouchAt: service?.last_touch_at ?? null, nextTouchAt: service?.next_touch_at ?? null,
      clientOwnerContactId: service?.client_owner_contact_id ?? null,
      clientOwnerContact: service?.owner_id ? { id: service.owner_id, name: service.owner_name } : null,
    },
  };
}

function ensureServiceOnboarding(company, now) {
  const service = pipelineRow('service');
  if (!db.prepare('SELECT 1 FROM company_pipeline_state WHERE company_id = ? AND pipeline_id = ?')
    .get(company.id, service.id)) {
    changeCompanyPipeline(company, service, 'onboarding', 'Оплата в воронке продажи', 'auto', now);
  }
}

function changeCompanyPipeline(company, pipeline, stageCode, reason, by = 'user', now = new Date().toISOString()) {
  const old = db.prepare('SELECT * FROM company_pipeline_state WHERE company_id = ? AND pipeline_id = ?')
    .get(company.id, pipeline.id);
  const cleanReason = reason === undefined ? null : checkedString(reason, 'reason');
  if (stageCode !== null && !db.prepare('SELECT 1 FROM pipeline_stages WHERE pipeline_id = ? AND code = ?')
    .get(pipeline.id, stageCode)) {
    fail(400, 'Этап не принадлежит выбранной воронке', { code: 'VALIDATION_ERROR', field: 'stageCode' });
  }
  if ((old?.stage_code ?? null) === stageCode) {
    if (pipeline.code === 'sale' && stageCode === 'paid') ensureServiceOnboarding(company, now);
    return false;
  }
  const needsReason = pipeline.code === 'sale' && stageCode === 'rejected' ||
    pipeline.code === 'service' && stageCode === 'churned';
  if (needsReason && !cleanReason) {
    fail(400, 'Укажите причину отказа или ухода', { code: 'VALIDATION_ERROR', field: 'reason' });
  }
  if (stageCode === null) {
    db.prepare('DELETE FROM company_pipeline_state WHERE company_id = ? AND pipeline_id = ?')
      .run(company.id, pipeline.id);
  } else {
    db.prepare(`INSERT INTO company_pipeline_state
      (company_id, pipeline_id, stage_code, entered_at, updated_at, return_task_created) VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(company_id, pipeline_id) DO UPDATE SET stage_code = excluded.stage_code,
        entered_at = excluded.entered_at, updated_at = excluded.updated_at, return_task_created = 0`)
      .run(company.id, pipeline.id, stageCode, now, now);
  }
  db.prepare(`INSERT INTO company_stage_history (company_id, pipeline_code, from_code, to_code, at, by, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(company.id, pipeline.code, old?.stage_code ?? null,
      stageCode, now, by, cleanReason);
  if (pipeline.code === 'sale') {
    db.prepare('UPDATE companies SET pipeline_stage = ?, updated_at = ? WHERE id = ?').run(stageCode, now, company.id);
  } else {
    db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(now, company.id);
  }
  if (pipeline.code === 'sale' && stageCode === 'paid') {
    ensureServiceOnboarding(company, now);
  }
  return true;
}

function moveCompanyPipeline(id, body) {
  if (Object.keys(body).some((key) => !['pipeline', 'stageCode', 'reason'].includes(key))) {
    fail(400, 'Неизвестное поле перехода', { code: 'VALIDATION_ERROR' });
  }
  const pipeline = pipelineRow(body.pipeline ?? 'sale');
  const stageCode = checkedString(body.stageCode, 'stageCode', false);
  return pipelineTransaction(() => {
    const company = entityRow(ENTITY_CONFIG.companies, id);
    changeCompanyPipeline(company, pipeline, stageCode, body.reason);
    return { company: serializeEntity(ENTITY_CONFIG.companies, entityRow(ENTITY_CONFIG.companies, id)) };
  });
}

function serviceTimestamp(value, field) {
  if (typeof value !== 'string') fail(400, 'Ожидалась дата ISO 8601', { code: 'VALIDATION_ERROR', field });
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${validDay(value, field)}T00:00:00.000Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(400, 'Дата должна содержать часовой пояс', { code: 'VALIDATION_ERROR', field });
  }
  validDay(value.slice(0, 10), field);
  return date(value, field);
}

function patchCompanyService(id, body) {
  const fields = { paidUntil: 'paid_until', monthlyAmount: 'monthly_amount', lastTouchAt: 'last_touch_at',
    nextTouchAt: 'next_touch_at', clientOwnerContactId: 'client_owner_contact_id' };
  const entries = Object.entries(body);
  if (!entries.length || entries.some(([key]) => !Object.hasOwn(fields, key))) {
    fail(400, 'Некорректные поля сопровождения', { code: 'VALIDATION_ERROR' });
  }
  const values = entries.map(([field, value]) => {
    if (value === null) return [fields[field], null];
    if (field === 'monthlyAmount') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(400, 'Сумма должна быть неотрицательным числом', { code: 'VALIDATION_ERROR', field });
      }
    } else if (field === 'clientOwnerContactId') {
      if (!Number.isSafeInteger(value) || value < 1 ||
          !db.prepare('SELECT 1 FROM contacts WHERE id = ? AND is_deleted = 0').get(value)) {
        fail(400, 'Ответственный контакт не найден', { code: 'VALIDATION_ERROR', field });
      }
    } else if (field === 'paidUntil') value = validDay(value, field);
    else value = serviceTimestamp(value, field);
    return [fields[field], value];
  });
  return pipelineTransaction(() => {
    entityRow(ENTITY_CONFIG.companies, id);
    db.prepare('INSERT OR IGNORE INTO company_service (company_id) VALUES (?)').run(id);
    db.prepare(`UPDATE company_service SET ${values.map(([field]) => `${field} = ?`).join(',')} WHERE company_id = ?`)
      .run(...values.map(([, value]) => value), id);
    db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return { company: serializeEntity(ENTITY_CONFIG.companies, entityRow(ENTITY_CONFIG.companies, id)) };
  });
}

function pipelineRules() {
  const row = db.prepare('SELECT * FROM pipeline_rules WHERE id = 1').get();
  return { silentDays: row.silent_days, renewalDays: row.renewal_days,
    rejectedReturnMonths: row.rejected_return_months, churnedReturnMonths: row.churned_return_months };
}

function replacePipelineRules(body) {
  const rules = body.rules;
  const allowed = ['silentDays', 'renewalDays', 'rejectedReturnMonths', 'churnedReturnMonths'];
  if (Object.keys(body).some((key) => key !== 'rules') || !rules || Array.isArray(rules) ||
      typeof rules !== 'object' || Object.keys(rules).length !== allowed.length ||
      Object.keys(rules).some((key) => !allowed.includes(key))) {
    fail(400, 'Ожидались четыре правила воронок', { code: 'VALIDATION_ERROR', field: 'rules' });
  }
  for (const field of allowed) {
    const max = field.endsWith('Months') ? 120 : 3650;
    if (!Number.isInteger(rules[field]) || rules[field] < 1 || rules[field] > max) {
      fail(400, `Правило «${field}» должно быть целым числом от 1 до ${max}`,
        { code: 'VALIDATION_ERROR', field });
    }
  }
  db.prepare(`UPDATE pipeline_rules SET silent_days = ?, renewal_days = ?,
    rejected_return_months = ?, churned_return_months = ? WHERE id = 1`).run(...allowed.map((field) => rules[field]));
  return { rules: pipelineRules() };
}

function addUtcMonths(value, months) {
  const source = new Date(value);
  const target = new Date(source);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), last));
  return target.getTime();
}

function applyPipelineRules() {
  return pipelineTransaction(() => {
    const rules = pipelineRules();
    const now = new Date();
    const at = now.toISOString();
    const day = Date.parse(`${at.slice(0, 10)}T00:00:00.000Z`);
    const service = pipelineRow('service');
    const active = db.prepare(`SELECT c.*, s.last_touch_at, s.paid_until FROM company_pipeline_state state
      JOIN companies c ON c.id = state.company_id LEFT JOIN company_service s ON s.company_id = c.id
      WHERE state.pipeline_id = ? AND state.stage_code = 'active' AND c.is_deleted = 0`).all(service.id);
    for (const company of active) {
      if (company.last_touch_at && now.getTime() - Date.parse(company.last_touch_at) > rules.silentDays * 86400000) {
        changeCompanyPipeline(company, service, 'risk', `Нет касаний более ${rules.silentDays} дней`, 'auto', at);
      } else if (company.paid_until &&
          (Date.parse(`${company.paid_until}T00:00:00.000Z`) - day) / 86400000 < rules.renewalDays) {
        changeCompanyPipeline(company, service, 'renewal', `До оплаты менее ${rules.renewalDays} дней`, 'auto', at);
      }
    }
    const returns = db.prepare(`SELECT c.*, state.pipeline_id, state.stage_code, state.entered_at, p.code pipeline_code
      FROM company_pipeline_state state JOIN companies c ON c.id = state.company_id
      JOIN pipelines p ON p.id = state.pipeline_id WHERE c.is_deleted = 0 AND state.return_task_created = 0
      AND ((p.code = 'sale' AND state.stage_code = 'rejected') OR
        (p.code = 'service' AND state.stage_code = 'churned'))`)
      .all();
    for (const company of returns) {
      const months = company.pipeline_code === 'sale' ? rules.rejectedReturnMonths : rules.churnedReturnMonths;
      if (now.getTime() < addUtcMonths(company.entered_at, months)) continue;
      const history = db.prepare(`SELECT id FROM company_stage_history WHERE company_id = ? AND pipeline_code = ?
        ORDER BY id DESC LIMIT 1`).get(company.id, company.pipeline_code);
      const sourceRef = `pipeline:${company.pipeline_code}:${company.id}:${history?.id || company.entered_at}`;
      db.prepare(`INSERT INTO tasks (created_at, updated_at, title, company_code, assignee_role, source, source_ref,
        description, created_by) VALUES (?, ?, ?, ?, 'owner', 'pipeline', ?, ?, 'auto')`)
        .run(at, at, `Вернуться к ${company.name}`, company.code, sourceRef,
          `Вернуться к компании после этапа «${company.stage_code}» (${months} мес.)`);
      db.prepare(`UPDATE company_pipeline_state SET return_task_created = 1, updated_at = ?
        WHERE company_id = ? AND pipeline_id = ?`).run(at, company.id, company.pipeline_id);
    }
  });
}

function pipelineStageCode(label, reservedCodes) {
  const letters = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const slug = label.toLowerCase().replace(/[а-яё]/g, (letter) => letters[letter])
    .normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
  let code = slug;
  let suffix = 2;
  while (reservedCodes.has(code)) {
    code = `${slug}-${suffix}`;
    suffix += 1;
  }
  reservedCodes.add(code);
  return code;
}

function replacePipelines(body) {
  if (Object.keys(body).some((key) => key !== 'pipelines') || !Array.isArray(body.pipelines) ||
      body.pipelines.length < 2 || body.pipelines.length > 12) {
    fail(400, 'Ожидался список от 2 до 12 воронок', { code: 'VALIDATION_ERROR', field: 'pipelines' });
  }
  return pipelineTransaction(() => {
    const current = pipelineList();
    const codes = new Set(current.map((pipeline) => pipeline.code));
    const reserved = new Set(codes);
    const seen = new Set();
    const pipelines = body.pipelines.map((pipeline, position) => {
      if (!pipeline || Array.isArray(pipeline) || typeof pipeline !== 'object' ||
          Object.keys(pipeline).some((key) => !['code', 'label'].includes(key))) {
        fail(400, 'Некорректная воронка', { code: 'VALIDATION_ERROR', field: `pipelines.${position}` });
      }
      const label = checkedString(pipeline.label, 'label', false);
      if ([...label].length > 40) fail(400, 'Название воронки длиннее 40 символов', { code: 'VALIDATION_ERROR' });
      let code;
      if (Object.hasOwn(pipeline, 'code')) {
        if (typeof pipeline.code !== 'string' || !codes.has(pipeline.code) || seen.has(pipeline.code)) {
          fail(400, 'Неизвестный или повторный код воронки', { code: 'VALIDATION_ERROR', field: 'code' });
        }
        code = pipeline.code;
      } else code = pipelineStageCode(label, reserved);
      seen.add(code);
      return { code, label, position };
    });
    if (current.some((pipeline) => !seen.has(pipeline.code))) {
      fail(400, 'Удаление воронок не поддерживается', { code: 'VALIDATION_ERROR', field: 'pipelines' });
    }
    const now = new Date().toISOString();
    for (const pipeline of pipelines) {
      if (codes.has(pipeline.code)) {
        db.prepare('UPDATE pipelines SET label = ?, position = ?, updated_at = ? WHERE code = ?')
          .run(pipeline.label, pipeline.position, now, pipeline.code);
      } else {
        const created = db.prepare(`INSERT INTO pipelines (code, label, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`).run(pipeline.code, pipeline.label, pipeline.position, now, now);
        db.prepare(`INSERT INTO pipeline_stages (pipeline_id, code, label, position, kind, created_at, updated_at)
          VALUES (?, 'new', 'Новый', 0, 'open', ?, ?)`).run(created.lastInsertRowid, now, now);
      }
    }
    return { pipelines: pipelineList() };
  });
}

function replacePipelineStages(body, pipelineCode = 'sale') {
  const pipeline = pipelineRow(pipelineCode);
  const current = pipelineStages(pipelineCode);
  const limit = Math.max(12, current.length);
  if (Object.keys(body).some((key) => key !== 'stages') || !Array.isArray(body.stages) ||
      body.stages.length < 1 || body.stages.length > limit) {
    fail(400, `Воронка должна содержать от 1 до ${limit} этапов`, { code: 'VALIDATION_ERROR', field: 'stages' });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentCodes = new Set(current.map((stage) => stage.code));
    const reservedCodes = new Set(currentCodes);
    const keptCodes = new Set();
    const stages = body.stages.map((stage, position) => {
      const field = `stages.${position}`;
      if (!stage || typeof stage !== 'object' || Array.isArray(stage) ||
          Object.keys(stage).some((key) => !['code', 'label', 'kind', 'attention'].includes(key))) {
        fail(400, 'Некорректный объект этапа', { code: 'VALIDATION_ERROR', field });
      }
      const label = typeof stage.label === 'string' ? stage.label.trim() : '';
      if (!label || Array.from(label).length > 40) {
        fail(400, 'Название этапа должно содержать от 1 до 40 символов',
          { code: 'VALIDATION_ERROR', field: `${field}.label` });
      }
      if (!['open', 'won', 'lost'].includes(stage.kind)) {
        fail(400, 'Тип этапа должен быть open, won или lost',
          { code: 'VALIDATION_ERROR', field: `${field}.kind` });
      }
      let code;
      if (Object.hasOwn(stage, 'code')) {
        if (typeof stage.code !== 'string' || !currentCodes.has(stage.code)) {
          fail(400, 'Неизвестный код этапа', { code: 'VALIDATION_ERROR', field: `${field}.code` });
        }
        code = stage.code;
        if (keptCodes.has(code)) {
          fail(400, 'Код этапа не должен повторяться', { code: 'VALIDATION_ERROR', field: `${field}.code` });
        }
      } else {
        code = pipelineStageCode(label, reservedCodes);
      }
      if (stage.attention !== undefined && ![true, false, 0, 1].includes(stage.attention)) {
        fail(400, 'attention должен быть boolean', { code: 'VALIDATION_ERROR', field: `${field}.attention` });
      }
      const attention = stage.attention ?? current.find((item) => item.code === code)?.attention ?? false;
      keptCodes.add(code);
      return { code, label, kind: stage.kind, position, attention: Boolean(attention) };
    });
    const removed = current.filter((stage) => !keptCodes.has(stage.code));
    const companyCount = db.prepare(`SELECT COUNT(*) count FROM company_pipeline_state
      WHERE pipeline_id = ? AND stage_code = ?`);
    for (const stage of removed) {
      if (stage.system) fail(400, 'Этап нужен для правил воронки и не может быть удалён',
        { code: 'PIPELINE_SYSTEM_STAGE', stageCode: stage.code });
      const count = companyCount.get(pipeline.id, stage.code).count;
      if (count) {
        fail(409, `В этапе «${stage.label}» есть ${count} компаний — сначала перенесите их`,
          { code: 'PIPELINE_STAGE_IN_USE', stageCode: stage.code, count });
      }
    }
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE pipeline_stages SET label = ?, position = ?, kind = ?, is_final = ?, attention = ?, updated_at = ?
      WHERE pipeline_id = ? AND code = ?
    `);
    const insert = db.prepare(`
      INSERT INTO pipeline_stages
        (code, label, position, kind, is_final, attention, created_at, updated_at, pipeline_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const stage of stages) {
      const { code, label, position, kind, attention } = stage;
      const isFinal = Number(kind !== 'open');
      if (currentCodes.has(code)) {
        update.run(label, position, kind, isFinal, Number(attention), now, pipeline.id, code);
      } else {
        insert.run(code, label, position, kind, isFinal, Number(attention), now, now, pipeline.id);
      }
    }
    const remove = db.prepare('DELETE FROM pipeline_stages WHERE pipeline_id = ? AND code = ?');
    for (const stage of removed) remove.run(pipeline.id, stage.code);
    db.exec('COMMIT');
    return { stages: pipelineStages(pipelineCode) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function companyOverview(id) {
  const row = entityRow(ENTITY_CONFIG.companies, id);
  const { contacts, legalEntities } = relationRows('companies', id);
  const tasks = db.prepare(`
    SELECT id, title, status, due_date FROM tasks
    WHERE company_code = ? COLLATE NOCASE AND is_deleted = 0 AND status NOT IN ('done', 'cancelled')
    ORDER BY created_at DESC, id DESC LIMIT 20
  `).all(row.code).map((task) => ({
    id: task.id, title: task.title, status: task.status, dueDate: task.due_date,
  }));
  const total = db.prepare('SELECT COUNT(*) count FROM leads WHERE company_code = ? COLLATE NOCASE')
    .get(row.code).count;
  const last = db.prepare(`
    SELECT id, created_at, name, stage, source FROM leads WHERE company_code = ? COLLATE NOCASE
    ORDER BY created_at DESC, id DESC LIMIT 5
  `).all(row.code).map((lead) => ({
    id: lead.id, createdAt: lead.created_at, name: lead.name, stage: lead.stage, source: lead.source,
  }));
  return {
    company: serializeEntity(ENTITY_CONFIG.companies, row),
    contacts,
    legalEntities,
    tasks,
    leads: { total, last },
    stageHistory: db.prepare(`SELECT id, pipeline_code pipelineCode, from_code fromCode, to_code toCode, at, by, reason
      FROM company_stage_history WHERE company_id = ? ORDER BY at DESC, id DESC`).all(id),
  };
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

  if (request.method === 'GET' && url.pathname === '/pipelines') {
    return send(response, 200, { pipelines: pipelineList() }, cors);
  }
  if (request.method === 'PUT' && url.pathname === '/pipelines') {
    return send(response, 200, replacePipelines(await readJson(request)), cors);
  }
  if (request.method === 'GET' && url.pathname === '/pipeline-rules') {
    return send(response, 200, { rules: pipelineRules() }, cors);
  }
  if (request.method === 'PUT' && url.pathname === '/pipeline-rules') {
    return send(response, 200, replacePipelineRules(await readJson(request)), cors);
  }
  if (request.method === 'GET' && url.pathname === '/pipeline-stages') {
    const pipeline = pipelineRow(url.searchParams.get('pipeline') ?? 'sale');
    applyPipelineRules();
    return send(response, 200, { stages: pipelineStages(pipeline.code) }, cors);
  }
  if (request.method === 'PUT' && url.pathname === '/pipeline-stages') {
    const body = await readJson(request);
    return send(response, 200, replacePipelineStages(body, url.searchParams.get('pipeline') ?? 'sale'), cors);
  }
  const pipelineMatch = url.pathname.match(/^\/companies\/(\d+)\/pipeline$/);
  if (request.method === 'PATCH' && pipelineMatch) {
    return send(response, 200, moveCompanyPipeline(entityId(pipelineMatch[1]), await readJson(request)), cors);
  }
  const serviceMatch = url.pathname.match(/^\/companies\/(\d+)\/service$/);
  if (request.method === 'PATCH' && serviceMatch) {
    return send(response, 200, patchCompanyService(entityId(serviceMatch[1]), await readJson(request)), cors);
  }
  const overviewMatch = url.pathname.match(/^\/companies\/(\d+)\/overview$/);
  if (request.method === 'GET' && overviewMatch) {
    return send(response, 200, companyOverview(entityId(overviewMatch[1])), cors);
  }
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
    const sourceStats = [...analytics.groups.values()]
      .sort((a, b) => a.source.localeCompare(b.source, 'ru'));
    const sources = analyticsSources(companyCode);
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
        visits: sourceStats.reduce((sum, item) => sum + item.visits, 0),
        clicks: sourceStats.reduce((sum, item) => sum + item.clicks, 0),
      },
      funnel,
      leads: rows.map(serializeCabinetLead),
      sources,
      sourceStats,
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
    const sourceStats = [...analytics.groups.values()]
      .sort((a, b) => a.source.localeCompare(b.source, 'ru'));
    const revenue = sourceStats.reduce((sum, group) => sum + group.revenue, 0);
    const expenses = companyCode ? null : sourceStats.reduce((sum, group) => sum + group.expenses, 0);
    return send(response, 200, {
      from, to, revenue, expenses, romi: companyCode ? null : romi(revenue, expenses),
      sources: sourceStats,
      sourceStats,
      visits: sourceStats.reduce((sum, group) => sum + group.visits, 0),
      clicks: sourceStats.reduce((sum, group) => sum + group.clicks, 0),
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

const pipelineRulesTimer = IS_MAIN ? setInterval(() => {
  try { applyPipelineRules(); } catch (error) { console.error('Ошибка правил воронок:', error); }
}, 60 * 60 * 1000) : null;
pipelineRulesTimer?.unref();
server.on('close', () => clearInterval(pipelineRulesTimer));

if (IS_MAIN) {
  server.listen(PORT, () => {
    console.log(`Мини-CRM слушает порт ${PORT}; база: ${DATABASE_PATH}`);
  });
}

function shutdown() {
  clearInterval(pipelineRulesTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

module.exports = { deriveSource };

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
