'use strict';
/* specs/226: каталог рабочих компаний кабинета хранится в базе content.
   Шесть исходных компаний — сид (коды и названия прежние). Объект COMPANIES остаётся
   общим реестром для всех модулей: его наполняет каталог, поэтому прежние проверки
   Object.hasOwn(COMPANIES, code) сразу видят новые компании без правки каждого модуля. */

const SEED = Object.freeze([
  ['synapse-business', 'Synapse Бизнес', null],
  ['taisabai', 'ТайСабай', null],
  ['novyi-etap', 'НовыйЭтап', null],
  ['alvi', 'Алви', 'alvi'],
  ['avokado', 'Авокадо', 'avokado'],
  ['palitra-love', 'Palitra', 'palitra'],
]);
const DEFAULT_TIMEZONE = 'Asia/Irkutsk';
const MODULES = Object.freeze(['content-factory']);
const REQUIRED_MODULES = Object.freeze(['content-factory']);
// Права ведения Контент-завода в созданной компании. Согласования (approve) здесь нет: оно у клиента.
const CONTENT_FACTORY_GRANT = Object.freeze(['autoposting.view', 'autoposting.edit', 'settings.view', 'settings.edit', 'analytics.view']);
const CODE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'system', 'owner', 'all', 'none', 'null', 'undefined', 'new', 'cabinet', 'content', 'crm']);

// Общий изменяемый реестр. Сид нужен до открытия базы (импорт модулей, тесты без базы).
const COMPANIES = {};
for (const [code, name, contentSiteId] of SEED) {
  COMPANIES[code] = { name, contentSiteId, city: '', timezone: DEFAULT_TIMEZONE, modules: [...MODULES] };
}

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function validTimezone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$|^UTC$/.test(value)) return false;
  try { new Intl.DateTimeFormat('ru-RU', { timeZone: value }).format(0); return true; } catch { return false; }
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Тело запроса должно быть объектом');
  const allowed = new Set(['code', 'name', 'city', 'timezone', 'modules']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(400, `Неизвестное поле «${key}»`);
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!CODE.test(code)) fail(400, 'Код: латиница в нижнем регистре, цифры и дефис, 1–40 символов, без дефиса по краям', 'CODE_INVALID');
  if (RESERVED.has(code)) fail(400, 'Этот код зарезервирован', 'CODE_RESERVED');
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 80 || /[<>]/.test(name)) fail(400, 'Название: от 1 до 80 символов, без < и >', 'NAME_INVALID');
  const city = input.city == null ? '' : typeof input.city === 'string' ? input.city.trim().replace(/\s+/g, ' ') : null;
  if (city === null || city.length > 80 || /[<>]/.test(city)) fail(400, 'Город: до 80 символов', 'CITY_INVALID');
  const timezone = input.timezone == null || input.timezone === '' ? DEFAULT_TIMEZONE : input.timezone;
  if (!validTimezone(timezone)) fail(400, 'Часовой пояс должен быть в формате IANA, например Asia/Irkutsk', 'TIMEZONE_INVALID');
  const modules = input.modules == null ? [...REQUIRED_MODULES] : input.modules;
  if (!Array.isArray(modules) || new Set(modules).size !== modules.length || modules.some((item) => !MODULES.includes(item))) {
    fail(400, 'Неизвестный модуль', 'MODULES_INVALID');
  }
  for (const item of REQUIRED_MODULES) if (!modules.includes(item)) fail(400, 'Контент-завод обязателен для новой компании', 'MODULES_INVALID');
  return { code, name, city, timezone, modules };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_companies (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT '${DEFAULT_TIMEZONE}',
      modules_json TEXT NOT NULL DEFAULT '["content-factory"]',
      content_site_id TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('seed','created')),
      position INTEGER NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  const stamp = new Date().toISOString();
  const insert = db.prepare(`INSERT OR IGNORE INTO workspace_companies
    (code, name, content_site_id, origin, position, created_at) VALUES (?, ?, ?, 'seed', ?, ?)`);
  SEED.forEach(([code, name, siteId], index) => insert.run(code, name, siteId, index, stamp));
}

function syncRegistry(db) {
  const rows = db.prepare('SELECT * FROM workspace_companies ORDER BY position, code').all();
  // Реестр общий для процесса: убираем только записи, которых нет в каталоге, и не трогаем сид без базы.
  for (const code of Object.keys(COMPANIES)) if (!rows.some((row) => row.code === code)) delete COMPANIES[code];
  for (const row of rows) {
    let modules;
    try { modules = JSON.parse(row.modules_json); } catch { modules = [...MODULES]; }
    COMPANIES[row.code] = { name: row.name, contentSiteId: row.content_site_id || null, city: row.city,
      timezone: row.timezone, modules: Array.isArray(modules) ? modules : [...MODULES] };
  }
  return rows;
}

function createCompanyCatalog(db) {
  migrate(db);
  syncRegistry(db);
  const row = (code) => db.prepare('SELECT * FROM workspace_companies WHERE code = ?').get(code);
  const dto = (code) => ({ id: code, ...COMPANIES[code] });
  return {
    has: (code) => typeof code === 'string' && Object.hasOwn(COMPANIES, code),
    get: (code) => (Object.hasOwn(COMPANIES, code) ? dto(code) : null),
    list: () => Object.keys(COMPANIES).map(dto),
    normalizeInput,
    /* Вставка выполняется внутри транзакции вызывающего (auth-store), чтобы каталог,
       выдача прав и журнал создавались вместе или не создавались вовсе. */
    insert(actorId, input) {
      if (row(input.code) || Object.hasOwn(COMPANIES, input.code)) fail(409, 'Компания с таким кодом уже есть', 'CODE_TAKEN');
      const position = (db.prepare('SELECT max(position) AS value FROM workspace_companies').get().value ?? -1) + 1;
      db.prepare(`INSERT INTO workspace_companies
        (code, name, city, timezone, modules_json, content_site_id, origin, position, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, 'created', ?, ?, ?)`)
        .run(input.code, input.name, input.city, input.timezone, JSON.stringify(input.modules), position, actorId, new Date().toISOString());
    },
    sync: () => syncRegistry(db),
  };
}

module.exports = { COMPANIES, CONTENT_FACTORY_GRANT, DEFAULT_TIMEZONE, MODULES, SEED, createCompanyCatalog, normalizeInput, validTimezone };
