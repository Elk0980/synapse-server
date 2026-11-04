'use strict';

/* Модули компании: какая функция каталога Synapse включена конкретной компании и с какими параметрами.
   Ключ модуля — id из каталога «Финансы → Модули и пакеты» (commercial.js); прайс здесь не хранится.
   Включение — решение владельца Synapse (owner): так же, как каталог и финансы. История изменений
   ведётся как у финансовых записей (before/after, автор, время), строка версионируется.
   Параметры — только описанные в MODULE_PARAMS поля; секреты (пароли SMTP, ключи ботов, токены)
   в параметрах не хранятся: общий SMTP остаётся в «Настройках системы». */

const { normalizeRecipientList } = require('./email-recipients');

/* Схема параметров. Неописанный параметр отклоняется — так в params не попадёт ничего лишнего. */
const MODULE_PARAMS = Object.freeze({
  crm: Object.freeze({
    leadEmailRecipients: Object.freeze({ type: 'emailList', label: 'Получатели писем о новых заявках',
      hint: 'До 5 адресов через запятую. Пустое поле — письма компании отключены. Не задано — используются «Получатели заявок» из настроек компании.' }),
  }),
});
const SECRET_NAME = /pass|secret|token|smtp|api.?key|private|credential/i;
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const KEY = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/* Обратимая миграция: только новые таблицы, прежние не меняются. */
function migrateCompanyModules(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_modules (
      company_code TEXT NOT NULL COLLATE NOCASE, module_key TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), params TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_by_id INTEGER, updated_at TEXT NOT NULL,
      PRIMARY KEY(company_code, module_key));
    CREATE TABLE IF NOT EXISTS company_module_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE, module_key TEXT NOT NULL,
      at TEXT NOT NULL, actor TEXT NOT NULL, actor_id INTEGER, before_data TEXT, after_data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS company_module_audit_company ON company_module_audit(company_code, id);`);
}
function revertCompanyModules(db) {
  db.exec('DROP INDEX IF EXISTS company_module_audit_company; DROP TABLE IF EXISTS company_module_audit; DROP TABLE IF EXISTS company_modules;');
}
const tableExists = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_modules'").get());

/* Адреса писем о заявках из включённого модуля CRM: {companyCode: "a@x, b@y"}. Только явно заданный параметр;
   его отсутствие оставляет прежние настройки почты компании. */
function moduleLeadRecipients(db) {
  if (!tableExists(db)) return {};
  const result = {};
  for (const row of db.prepare("SELECT company_code, params FROM company_modules WHERE module_key='crm' AND enabled=1").all()) {
    let params; try { params = JSON.parse(row.params); } catch { continue; }
    if (typeof params?.leadEmailRecipients === 'string') result[String(row.company_code).toLowerCase()] = params.leadEmailRecipients;
  }
  return result;
}

function createCompanyModules({ db, fail, getCatalog, now = () => new Date().toISOString() }) {
  migrateCompanyModules(db);
  const bad = (message) => fail(400, message, { code: 'VALIDATION_ERROR' });
  const company = (code) => {
    if (typeof code !== 'string' || !CODE.test(code)) bad('Выберите компанию');
    const row = db.prepare('SELECT id, code, name FROM companies WHERE code = ? COLLATE NOCASE AND is_deleted = 0').get(code);
    if (!row) fail(404, 'Компания не найдена', { code: 'NOT_FOUND' });
    return row;
  };
  const products = () => (getCatalog().products || []);
  const product = (key) => {
    if (typeof key !== 'string' || !KEY.test(key)) bad('Неизвестный модуль');
    const found = products().find((item) => item.id === key);
    if (!found) bad('Модуль не найден в каталоге');
    return found;
  };
  const rowOf = (code, key) => db.prepare('SELECT * FROM company_modules WHERE company_code = ? COLLATE NOCASE AND module_key = ?').get(code, key);
  const paramsOf = (row) => { try { return row ? JSON.parse(row.params) : {}; } catch { return {}; } };

  function validateParams(key, value) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Параметры модуля — объект');
    const schema = Object.hasOwn(MODULE_PARAMS, key) ? MODULE_PARAMS[key] : {};
    const out = {};
    for (const [name, raw] of Object.entries(value)) {
      if (SECRET_NAME.test(name)) bad('Секреты в параметрах модуля не хранятся: SMTP и ключи настраиваются в настройках системы');
      // Только собственные поля схемы: __proto__, constructor, toString и т. п. — неизвестный параметр.
      const field = Object.hasOwn(schema, name) ? schema[name] : null;
      if (!field) bad(`Неизвестный параметр модуля: ${name}`);
      if (raw === null) continue; // null — параметр не задан
      if (field.type === 'emailList') {
        if (typeof raw !== 'string') bad('Укажите адреса строкой');
        try { out[name] = normalizeRecipientList(raw); } catch (error) { bad(error.message); }
      }
    }
    return out;
  }

  /* Модули, отмеченные «приобретён» в сделках, где эта компания — клиент. Только ссылки на сделки. */
  function purchases(companyRow) {
    const byKey = new Map();
    const names = new Map(products().map((item) => [item.name, item.id]));
    for (const deal of db.prepare('SELECT id, title, data FROM deal_orders WHERE company_id = ? ORDER BY id').all(companyRow.id)) {
      let data; try { data = JSON.parse(deal.data || '{}'); } catch { continue; }
      for (const item of Array.isArray(data.modules) ? data.modules : []) {
        if (item?.purchase !== 'purchased') continue;
        const key = item.productId || names.get(item.name);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        if (!byKey.get(key).some((d) => d.dealId === deal.id)) byKey.get(key).push({ dealId: deal.id, title: deal.title });
      }
    }
    return byKey;
  }
  const schemaJSON = (key) => Object.entries(Object.hasOwn(MODULE_PARAMS, key) ? MODULE_PARAMS[key] : {}).map(([name, field]) => ({ name, ...field }));
  const moduleJSON = (item, row, bought) => ({ key: item.id, name: item.name, status: item.status, billing: item.billing,
    enabled: Boolean(row?.enabled), params: paramsOf(row), version: row?.version || 0,
    updatedBy: row?.updated_by || null, updatedAt: row?.updated_at || null,
    purchased: Boolean(bought?.length), purchasedIn: bought || [], paramsSchema: schemaJSON(item.id) });

  function list(code) {
    const companyRow = company(code);
    const bought = purchases(companyRow);
    const rows = new Map(db.prepare('SELECT * FROM company_modules WHERE company_code = ? COLLATE NOCASE').all(companyRow.code).map((row) => [row.module_key, row]));
    const catalogKeys = new Set(products().map((item) => item.id));
    const modules = products().map((item) => moduleJSON(item, rows.get(item.id), bought.get(item.id)));
    // Модуль удалён из каталога, но был включён — показываем, чтобы его можно было выключить.
    for (const [key, row] of rows) if (!catalogKeys.has(key)) modules.push({ ...moduleJSON({ id: key, name: key, status: 'removed', billing: null }, row, bought.get(key)) });
    const history = db.prepare('SELECT * FROM company_module_audit WHERE company_code = ? COLLATE NOCASE ORDER BY id DESC LIMIT 30').all(companyRow.code)
      .map((row) => {
        // Повреждённая строка истории не роняет раздел: показывается без содержимого.
        const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
        return { id: row.id, moduleKey: row.module_key, at: row.at, actor: row.actor,
          before: parse(row.before_data), after: parse(row.after_data) || { enabled: null, params: {}, unreadable: true } };
      });
    return { companyCode: companyRow.code, companyName: companyRow.name, modules, history };
  }

  function save(code, key, body, actor) {
    if (actor?.role !== 'owner') fail(403, 'Модули компании включает владелец', { code: 'FORBIDDEN' });
    const companyRow = company(code);
    const existingRow = rowOf(companyRow.code, key);
    // Ключ из каталога; модуль, уже удалённый из каталога, можно только сохранить выключенным.
    if (!existingRow || body?.enabled !== false) product(key);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !['enabled', 'params', 'version'].includes(k))) bad('Неизвестное поле');
    if (typeof body.enabled !== 'boolean') bad('Укажите, включён ли модуль');
    if (!Number.isSafeInteger(body.version) || body.version < 0) bad('Нужна версия записи');
    const params = body.params === undefined ? paramsOf(existingRow) : validateParams(key, body.params);
    const at = now(), who = String(actor.userName || 'Владелец').slice(0, 200), whoId = Number.isSafeInteger(actor.userId) ? actor.userId : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = rowOf(companyRow.code, key);
      if ((current?.version || 0) !== body.version) fail(409, 'Модуль уже изменён. Обновите раздел.', { code: 'CONFLICT' });
      const before = current ? { enabled: Boolean(current.enabled), params: paramsOf(current) } : null;
      const after = { enabled: body.enabled, params };
      if (before && before.enabled === after.enabled && JSON.stringify(before.params) === JSON.stringify(after.params)) {
        db.exec('ROLLBACK');
        return list(companyRow.code);
      }
      if (current) db.prepare('UPDATE company_modules SET enabled=?, params=?, version=version+1, updated_by=?, updated_by_id=?, updated_at=? WHERE company_code=? COLLATE NOCASE AND module_key=? AND version=?')
        .run(after.enabled ? 1 : 0, JSON.stringify(params), who, whoId, at, companyRow.code, key, body.version);
      else db.prepare('INSERT INTO company_modules(company_code,module_key,enabled,params,version,updated_by,updated_by_id,updated_at) VALUES(?,?,?,?,1,?,?,?)')
        .run(companyRow.code.toLowerCase(), key, after.enabled ? 1 : 0, JSON.stringify(params), who, whoId, at);
      db.prepare('INSERT INTO company_module_audit(company_code,module_key,at,actor,actor_id,before_data,after_data) VALUES(?,?,?,?,?,?,?)')
        .run(companyRow.code.toLowerCase(), key, at, who, whoId, before ? JSON.stringify(before) : null, JSON.stringify(after));
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return list(companyRow.code);
  }

  /* Для серверного кода: состояние модуля компании. Нет записи — выключен, параметров нет. */
  function companyModule(code, key) {
    const row = typeof code === 'string' && typeof key === 'string' ? rowOf(code, key) : null;
    return { enabled: Boolean(row?.enabled), params: paramsOf(row) };
  }

  return { list, save, companyModule };
}

module.exports = { createCompanyModules, migrateCompanyModules, revertCompanyModules, moduleLeadRecipients, MODULE_PARAMS };
