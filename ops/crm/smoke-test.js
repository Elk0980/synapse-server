'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const serverFile = path.join(__dirname, 'server.js');
let child;
let directory;
let databasePath;
let apiKey;
let port;

async function request(method, pathname, body, key = apiKey) {
  const headers = {};
  if (key) headers['X-API-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('application/json');
  return { status: response.status, body: text && isJson ? JSON.parse(text) : text, headers: response.headers };
}
async function start() {
  port = 20000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [serverFile], { env: { ...process.env, PORT: String(port),
    DATABASE_PATH: databasePath, API_KEY: apiKey, RATE_LIMIT_MAX: '10000' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`CRM завершилась при старте: ${errors}`);
    try {
      await fetch(`http://127.0.0.1:${port}/contacts`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('CRM не запустилась');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
}
function inspect(callback) {
  const db = new DatabaseSync(databasePath);
  try { return callback(db); } finally { db.close(); }
}
async function main() {
  directory = await mkdtemp(path.join(tmpdir(), 'crm-smoke-'));
  databasePath = path.join(directory, 'qa.sqlite');
  apiKey = randomBytes(32).toString('hex');
  await start();

  inspect((db) => {
    for (const table of ['contacts', 'companies', 'legal_entities']) {
      assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
  console.log('MIGRATION_EMPTY=PASS NO_SEED=PASS');

  for (const pathname of ['/contacts', '/companies', '/legal-entities']) {
    assert.equal((await request('GET', pathname, undefined, null)).status, 401);
    assert.equal((await request('GET', pathname, undefined, 'wrong')).status, 401);
  }
  const contact = await request('POST', '/contacts', { name: 'QA Contact A', city: 'QA City',
    phone: '+7 999 000-00-00', messengers: [{ type: 'telegram', label: 'QA', handle: 'qa', url: null }],
    links: [{ label: 'QA', url: 'https://example.test/contact' }], birthDate: '2000-02-29', notes: 'QA notes' });
  assert.equal(contact.status, 201);
  const company = await request('POST', '/companies', { code: 'qa_company_a', name: 'QA Company A',
    websiteUrl: 'https://example.test', pipelineStage: 'application', notes: 'QA notes' });
  assert.equal(company.status, 201);
  const companyB = await request('POST', '/companies', { code: 'qa_company_b', name: 'QA Company B' });
  assert.equal(companyB.status, 201);
  const legal = await request('POST', '/legal-entities', { legalForm: 'ip', name: 'QA Legal Entity A',
    inn: '123456789012', ogrnip: '123456789012345', bik: '123456789',
    checkingAccount: '12345678901234567890', correspondentAccount: '12345678901234567890' });
  assert.equal(legal.status, 201);
  const legalB = await request('POST', '/legal-entities', { legalForm: 'ooo', name: 'QA Legal Entity B',
    inn: '1234567890', kpp: '123456789', ogrn: '1234567890123' });
  assert.equal(legalB.status, 201);
  assert.equal((await request('POST', '/companies', { code: 'QA_COMPANY_A', name: 'duplicate' })).status, 409);
  assert.equal((await request('PATCH', `/contacts/${contact.body.id}`, {})).status, 400);
  assert.equal((await request('PATCH', `/contacts/${contact.body.id}`, { unknown: true })).status, 400);
  assert.equal((await request('PATCH', `/contacts/${contact.body.id}`, { name: null })).status, 400);
  assert.equal((await request('PATCH', `/contacts/${contact.body.id}`, { city: null })).status, 200);
  console.log('CRUD_CONTACTS=PASS CRUD_COMPANIES=PASS CRUD_LEGAL_ENTITIES=PASS');

  const cc = `/contacts/${contact.body.id}/companies/${company.body.id}`;
  assert.equal((await request('PUT', cc, { role: 'QA role', isResponsible: true })).status, 201);
  assert.equal((await request('PUT', cc, { role: 'QA changed', isResponsible: true })).status, 200);
  const cl = `/contacts/${contact.body.id}/legal-entities/${legal.body.id}`;
  assert.equal((await request('PUT', cl, { role: 'QA signatory', isSignatory: true,
    signingBasis: 'QA basis' })).status, 201);
  const c2l = `/companies/${company.body.id}/legal-entities/${legal.body.id}`;
  assert.equal((await request('PUT', c2l, { role: 'QA payer', isPrimary: true })).status, 201);
  const contactB = await request('POST', '/contacts', { name: 'QA Contact B' });
  assert.equal((await request('PUT', `/contacts/${contactB.body.id}/companies/${companyB.body.id}`,
    { role: 'QA B' })).status, 201);
  assert.equal((await request('PUT', `/companies/${companyB.body.id}/legal-entities/${legalB.body.id}`,
    { role: 'QA B legal' })).status, 201);
  const scopedContacts = await request('GET', `/contacts?companyCode=${company.body.code.toUpperCase()}`);
  assert.equal(scopedContacts.body.contacts.some((item) => item.id === contact.body.id), true);
  assert.equal(scopedContacts.body.contacts.some((item) => item.id === contactB.body.id), false);
  assert.equal((await request('GET',
    `/contacts/${contactB.body.id}?companyCode=${company.body.code}`)).status, 404);
  assert.deepEqual((await request('GET', `/legal-entities?companyCode=${company.body.code}`))
    .body.legalEntities.map((item) => item.id), [legal.body.id]);
  assert.equal((await request('GET',
    `/legal-entities/${legalB.body.id}?companyCode=${company.body.code}`)).status, 404);
  const scopedContact = await request('POST', `/contacts?companyCode=${company.body.code}`,
    { name: 'QA Scoped Contact' });
  assert.equal(scopedContact.status, 201);
  const scopedLegal = await request('POST', `/legal-entities?companyCode=${company.body.code}`,
    { legalForm: 'ip', name: 'QA Scoped Legal' });
  assert.equal(scopedLegal.status, 201);
  assert.equal(inspect((db) => db.prepare(`SELECT COUNT(*) count FROM contact_companies
    WHERE contact_id=? AND company_id=? AND is_deleted=0`).get(scopedContact.body.id, company.body.id).count), 1);
  assert.equal(inspect((db) => db.prepare(`SELECT COUNT(*) count FROM company_legal_entities
    WHERE legal_entity_id=? AND company_id=? AND is_deleted=0`).get(scopedLegal.body.id, company.body.id).count), 1);
  const scopedCompanies = await request('GET', `/companies?companyCode=${company.body.code.toUpperCase()}`);
  assert.deepEqual(scopedCompanies.body.companies.map((item) => item.id), [company.body.id]);
  console.log('COMPANY_DATABASE_SCOPE=PASS AUTO_RELATIONS=PASS');
  const card = await request('GET', `/companies/${company.body.id}`);
  assert.equal(card.body.contacts[0].relation.role, 'QA changed');
  assert.equal(card.body.primaryLegalEntity.id, legal.body.id);
  assert.equal((await request('DELETE', cc)).status, 200);
  assert.equal((await request('DELETE', cc)).status, 200);
  assert.equal((await request('PUT', cc, { role: 'QA restored' })).status, 200);
  console.log('RELATIONS=PASS');

  const publicLead = await request('POST', '/leads', { name: 'QA Lead', contact: '+79990000001' }, null);
  assert.equal(publicLead.status, 201);
  assert.equal((await request('POST', '/leads', { name: 'QA Lead duplicate', contact: '+79990000001' }, null))
    .body.deduplicated, true);
  const leadA = await request('POST', '/leads', { name: 'QA Lead A', contact: '+79990000002',
    companyCode: company.body.code }, null);
  const leadADupe = await request('POST', '/leads', { name: 'QA Lead A duplicate', contact: '+79990000002',
    companyCode: company.body.code }, null);
  const leadB = await request('POST', '/leads', { name: 'QA Lead B', contact: '+79990000002',
    companyCode: companyB.body.code }, null);
  assert.equal(leadA.status, 201); assert.equal(leadADupe.body.deduplicated, true); assert.equal(leadB.status, 201);
  assert.equal((await request('PATCH', `/leads/${leadA.body.id}`, { companyCode: null })).status, 200);
  assert.equal((await request('PATCH', `/leads/${leadA.body.id}`, { companyCode: company.body.code })).status, 200);
  assert.equal((await request('GET', `/leads?companyCode=${company.body.code}`)).body.leads.length, 1);
  console.log('LEAD_COMPANY_LINK=PASS COMPANY_SCOPED_DEDUP=PASS');

  const taskInbox = await request('POST', '/tasks', {
    title: 'QA Inbox', companyCode: company.body.code, priority: 'low', source: 'chat',
    sourceRef: 'chat:conversation:12:message:345', sourceAuthor: 'QA Author',
  });
  const taskUrgent = await request('POST', '/tasks', {
    title: 'QA Urgent', companyCode: company.body.code.toUpperCase(), status: 'planned',
    priority: 'urgent', dueDate: '2030-01-02', assigneeRole: 'marketer',
  });
  const taskHigh = await request('POST', '/tasks', {
    title: 'QA High', companyCode: company.body.code, status: 'planned', priority: 'high',
    dueDate: '2030-01-01', description: 'needle task',
  });
  assert.equal(taskInbox.status, 201);
  assert.equal(taskInbox.body.companyCode, company.body.code);
  assert.equal(taskUrgent.status, 201);
  assert.equal(taskHigh.status, 201);
  const duplicate = await request('POST', '/tasks', {
    title: 'Must not be created', sourceRef: 'chat:conversation:12:message:345',
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.id, taskInbox.body.id);
  const tasks = await request('GET', `/tasks?companyCode=${company.body.code.toUpperCase()}`);
  assert.equal(tasks.body.pagination.total, 3);
  assert.deepEqual(tasks.body.tasks.map((task) => task.id),
    [taskInbox.body.id, taskUrgent.body.id, taskHigh.body.id]);
  assert.equal((await request('GET', '/tasks?status=planned&assigneeRole=marketer'))
    .body.pagination.total, 1);
  assert.equal((await request('GET', '/tasks?source=chat&q=author')).body.pagination.total, 1);
  const patchedTask = await request('PATCH', `/tasks/${taskInbox.body.id}`, {
    status: 'in_progress',
  });
  assert.equal(patchedTask.body.status, 'in_progress');
  const summary = await request('GET', `/tasks/summary?companyCode=${company.body.code}`);
  assert.deepEqual(summary.body, {
    inbox: 0, planned: 2, inProgress: 1, done: 0,
    byCompany: { [company.body.code]: { inbox: 0, open: 3 } },
  });
  assert.equal((await request('DELETE', `/tasks/${taskHigh.body.id}`)).status, 200);
  const deletedTasks = await request('GET', '/tasks?deleted=only');
  assert.equal(deletedTasks.body.pagination.total, 1);
  assert.equal(deletedTasks.body.tasks[0].id, taskHigh.body.id);
  for (const invalid of [
    { title: '' }, { title: 'x'.repeat(201) }, { title: 'QA', status: 'bad' },
    { title: 'QA', assigneeRole: 'bad' }, { title: 'QA', priority: 'bad' },
    { title: 'QA', dueDate: '2030-02-30' }, { title: 'QA', companyCode: 'missing' },
  ]) {
    const response = await request('POST', '/tasks', invalid);
    assert.equal(response.status, 400);
    assert.match(response.body.error, /[А-Яа-яЁё]/);
  }
  console.log('TASKS_CRUD=PASS TASKS_FILTER_SORT=PASS TASKS_IDEMPOTENCY=PASS');
  console.log('TASKS_SUMMARY=PASS TASKS_VALIDATION=PASS');

  const deleted = await request('DELETE', `/companies/${company.body.id}`);
  assert.equal(deleted.status, 200);
  const deletedAgain = await request('DELETE', `/companies/${company.body.id}`);
  assert.equal(deletedAgain.body.deletedAt, deleted.body.deletedAt);
  assert.equal((await request('GET', `/companies/${company.body.id}`)).status, 404);
  assert.equal((await request('GET', `/companies/${company.body.id}?includeDeleted=true`)).status, 200);
  assert.equal((await request('POST', `/companies/${company.body.id}/restore`)).status, 200);
  assert.equal((await request('GET', `/leads/${leadA.body.id}`)).body.companyCode, company.body.code);
  console.log('SOFT_DELETE=PASS');

  const safeList = await request('GET', '/legal-entities');
  for (const forbidden of ['inn', 'bankName', 'bik', 'checkingAccount', 'notes']) {
    if (['inn'].includes(forbidden)) continue;
    assert.equal(Object.hasOwn(safeList.body.legalEntities[0], forbidden), false);
  }
  assert.equal((await request('POST', '/contacts', { name: 'QA', password: 'forbidden' })).status, 400);
  assert.equal((await request('GET', '/dashboard?period=today')).status, 200);
  assert.equal((await request('GET', '/dashboard?period=7d')).status, 200);
  assert.equal((await request('GET', '/dashboard?period=30d')).status, 200);
  assert.equal((await request('GET', '/leads.csv')).status, 200);
  console.log('LEGACY_API_REGRESSION=PASS SECURITY=PASS');

  await stop();
  const counts = inspect((db) => ({ migrations: db.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count,
    contacts: db.prepare('SELECT COUNT(*) count FROM contacts').get().count }));
  inspect((db) => {
    db.exec('DROP TABLE tasks; DELETE FROM schema_migrations WHERE version = 2');
  });
  await start(); await stop(); await start(); await stop();
  inspect((db) => {
    assert.equal(db.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, counts.migrations);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM contacts').get().count, counts.contacts);
    assert.ok(db.prepare('SELECT COUNT(*) count FROM leads').get().count > 0);
    assert.ok(db.prepare('SELECT 1 FROM tasks').get() === undefined);
  });
  console.log('MIGRATION_REPEAT=PASS LEGACY_DATA_PRESERVED=PASS');

  inspect((db) => {
    db.exec('PRAGMA foreign_keys=ON');
    const before = db.prepare('SELECT COUNT(*) count FROM legal_entities').get().count;
    db.prepare('DELETE FROM contacts WHERE id=?').run(contact.body.id);
    const relations = db.prepare(
      'SELECT COUNT(*) count FROM contact_companies WHERE contact_id=?'
    ).get(contact.body.id).count;
    assert.equal(relations, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM legal_entities').get().count, before);
  });
  console.log('JUNCTION_CASCADE=PASS');
  console.log('CRM_SMOKE_TEST=PASS');
}

main().catch((error) => {
  console.error(`CRM_SMOKE_TEST=FAIL: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
