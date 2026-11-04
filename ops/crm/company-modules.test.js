'use strict';

/* Модули компании: каталог, включение владельцем, параметры без секретов, история, связь со сделкой,
   изоляция компаний, адреса писем о заявках через модуль с запасным чтением прежних настроек,
   миграция и откат. node --test ops/crm/company-modules.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createCompanyModules, migrateCompanyModules, revertCompanyModules, moduleLeadRecipients } = require('./company-modules');
const { createEmailSettings } = require('./email-settings');
const { PRODUCTS } = require('./commercial');

const fail = (status, message, details) => { throw Object.assign(new Error(message), { status, details }); };
const owner = { role: 'owner', userId: 1, userName: 'Влад' };
const editor = { role: 'editor', userId: 2, userName: 'Редактор' };
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE deal_orders(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
    INSERT INTO companies(id,code,name) VALUES(1,'alvi','ALVI'),(2,'avokado','Авокадо'),(3,'gone','Удалена');
    UPDATE companies SET is_deleted=1 WHERE code='gone';`);
  db.prepare('INSERT INTO deal_orders(company_id,title,data) VALUES(?,?,?)').run(1, 'Партнёры ALVI', JSON.stringify({ modules: [
    { productId: 'analytics', name: 'Сквозная аналитика', purchase: 'purchased' },
    { productId: 'website', name: 'Создание сайта', purchase: 'planned' },
    { name: 'CRM-система', purchase: 'purchased' } ] }));
  const catalog = { products: PRODUCTS };
  const modules = createCompanyModules({ db, fail, getCatalog: () => catalog });
  return { db, modules, catalog };
}
const status = (fn) => { try { fn(); } catch (error) { return error.status; } return 200; };

test('список — модули каталога, по умолчанию выключены; приобретённые в сделке компании отмечены', () => {
  const { modules } = setup();
  const alvi = modules.list('alvi');
  assert.deepEqual(alvi.modules.map((m) => m.key), PRODUCTS.map((p) => p.id));
  assert.ok(alvi.modules.every((m) => m.enabled === false && m.version === 0));
  const byKey = Object.fromEntries(alvi.modules.map((m) => [m.key, m]));
  assert.equal(byKey.analytics.purchased, true);
  assert.deepEqual(byKey.analytics.purchasedIn, [{ dealId: 1, title: 'Партнёры ALVI' }]);
  assert.equal(byKey.crm.purchased, true, 'старые строки сделки без productId сопоставляются по названию');
  assert.equal(byKey.website.purchased, false, 'запланированный — не приобретён');
  assert.equal(modules.list('avokado').modules.some((m) => m.purchased), false, 'сделка чужой компании не видна');
  assert.equal(byKey.crm.paramsSchema[0].name, 'leadEmailRecipients');
  assert.equal(status(() => modules.list('gone')), 404);
  assert.equal(status(() => modules.list('bad/code')), 400);
});

test('включает только владелец; параметры по схеме, без секретов; версия и история', () => {
  const { db, modules } = setup();
  assert.equal(status(() => modules.save('alvi', 'crm', { enabled: true, version: 0 }, editor)), 403);
  assert.equal(status(() => modules.save('alvi', 'unknown', { enabled: true, version: 0 }, owner)), 400);
  for (const params of [{ smtpPassword: 'x' }, { botToken: 'x' }, { apiKey: 'x' }, { other: 'x' }, { leadEmailRecipients: 'not-an-email' }, { leadEmailRecipients: 5 }, []]) {
    assert.equal(status(() => modules.save('alvi', 'crm', { enabled: true, version: 0, params }, owner)), 400, JSON.stringify(params));
  }
  assert.equal(status(() => modules.save('alvi', 'analytics', { enabled: true, version: 0, params: { leadEmailRecipients: 'a@b.test' } }, owner)), 400, 'у модуля нет такого параметра');
  assert.equal(status(() => modules.save('alvi', 'crm', { enabled: 'yes', version: 0 }, owner)), 400);
  assert.equal(status(() => modules.save('alvi', 'crm', { enabled: true }, owner)), 400);
  assert.equal(db.prepare('SELECT count(*) n FROM company_modules').get().n, 0, 'отклонённое не сохраняется');

  const saved = modules.save('alvi', 'crm', { enabled: true, version: 0, params: { leadEmailRecipients: 'Owner@Example.TEST, admin@example.test' } }, owner);
  const crm = saved.modules.find((m) => m.key === 'crm');
  assert.equal(crm.enabled, true);
  assert.equal(crm.version, 1);
  assert.deepEqual(crm.params, { leadEmailRecipients: 'Owner@example.test, admin@example.test' });
  assert.equal(crm.updatedBy, 'Влад');
  assert.equal(status(() => modules.save('alvi', 'crm', { enabled: false, version: 0 }, owner)), 409, 'устаревшая версия');
  // Повтор без изменений — ни версии, ни записи истории.
  modules.save('alvi', 'crm', { enabled: true, version: 1 }, owner);
  assert.equal(db.prepare('SELECT count(*) n FROM company_module_audit').get().n, 1);
  const off = modules.save('alvi', 'crm', { enabled: false, version: 1 }, owner);
  assert.equal(off.modules.find((m) => m.key === 'crm').params.leadEmailRecipients, 'Owner@example.test, admin@example.test', 'выключение сохраняет параметры');
  assert.deepEqual(off.history.map((h) => [h.moduleKey, h.before?.enabled ?? null, h.after.enabled]), [['crm', true, false], ['crm', null, true]]);
  assert.equal(off.history[0].actor, 'Влад');
  assert.deepEqual(modules.companyModule('alvi', 'crm'), { enabled: false, params: { leadEmailRecipients: 'Owner@example.test, admin@example.test' } });
  // Изоляция компаний.
  assert.deepEqual(modules.companyModule('avokado', 'crm'), { enabled: false, params: {} });
  assert.equal(modules.list('avokado').history.length, 0);
  assert.deepEqual(modules.companyModule('alvi', 'website'), { enabled: false, params: {} });
});

test('модуль, удалённый из каталога, остаётся видимым и выключается', () => {
  const { modules, catalog } = setup();
  modules.save('alvi', 'chat', { enabled: true, version: 0 }, owner);
  catalog.products = PRODUCTS.filter((p) => p.id !== 'chat');
  const chat = modules.list('alvi').modules.find((m) => m.key === 'chat');
  assert.equal(chat.status, 'removed');
  assert.equal(status(() => modules.save('alvi', 'chat', { enabled: true, version: 1 }, owner)), 400);
  assert.equal(modules.save('alvi', 'chat', { enabled: false, version: 1 }, owner).modules.find((m) => m.key === 'chat').enabled, false);
});

test('письма о заявках: адреса из модуля CRM, иначе прежние настройки; ALVI/Авокадо без модуля не меняются', () => {
  const { db, modules } = setup();
  const environment = { LEADS_NOTIFY_EMAIL_ALVI: 'alvi@example.test', LEADS_NOTIFY_EMAIL_AVOKADO: 'avokado@example.test', LEADS_NOTIFY_EMAIL: 'synapse@example.test' };
  const settings = createEmailSettings(db, { apiKey: 'fixture-key', environment, moduleRecipients: () => moduleLeadRecipients(db) });
  const plain = createEmailSettings(new DatabaseSync(':memory:'), { apiKey: 'fixture-key', environment });
  const to = (store, code) => store.notifications.recipients({ company_code: code });
  for (const code of ['alvi', 'avokado', 'synapse-business', 'other']) assert.deepEqual(to(settings, code), to(plain, code), `без модуля как прежде: ${code}`);
  assert.deepEqual(to(settings, 'alvi'), ['alvi@example.test']);
  assert.deepEqual(to(settings, 'avokado'), ['avokado@example.test']);
  // Включён без параметра — прежние настройки.
  modules.save('alvi', 'crm', { enabled: true, version: 0 }, owner);
  assert.deepEqual(to(settings, 'alvi'), ['alvi@example.test']);
  // Параметр задан — главнее прежних; соседняя компания не затронута.
  modules.save('alvi', 'crm', { enabled: true, version: 1, params: { leadEmailRecipients: 'm1@example.test, m2@example.test' } }, owner);
  assert.deepEqual(to(settings, 'alvi'), ['m1@example.test', 'm2@example.test']);
  assert.deepEqual(to(settings, 'avokado'), ['avokado@example.test']);
  assert.equal(settings.getCompany('alvi').source, 'module');
  assert.equal(settings.getCompany('avokado').source, undefined);
  assert.equal(settings.getPublic().alviRecipient, 'alvi@example.test', 'настройки отправителя не меняются');
  // Пустой параметр — явное отключение писем этой компании.
  modules.save('alvi', 'crm', { enabled: true, version: 2, params: { leadEmailRecipients: '' } }, owner);
  assert.deepEqual(to(settings, 'alvi'), []);
  // Модуль выключен — снова прежние настройки.
  modules.save('alvi', 'crm', { enabled: false, version: 3 }, owner);
  assert.deepEqual(to(settings, 'alvi'), ['alvi@example.test']);
});

test('миграция на прежней схеме и откат', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT, name TEXT, is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'alvi','ALVI',0);");
  assert.deepEqual(moduleLeadRecipients(db), {}, 'до миграции читатель почты работает');
  migrateCompanyModules(db); migrateCompanyModules(db);
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'company_module%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables(), ['company_module_audit', 'company_modules']);
  revertCompanyModules(db);
  assert.deepEqual(tables(), []);
  assert.equal(db.prepare('SELECT count(*) n FROM companies').get().n, 1, 'прежние таблицы не тронуты');
});
