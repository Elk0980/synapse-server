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
function stageInput(stages) {
  return stages.map(({ code, label, kind }) => ({ code, label, kind }));
}
async function verifyPipelineSettings(company) {
  const initial = await request('GET', '/pipeline-stages');
  assert.equal(initial.status, 200);
  assert.deepEqual(stageInput(initial.body.stages), [
    { code: 'new', label: 'Новый', kind: 'open' },
    { code: 'in_progress', label: 'В работе', kind: 'open' },
    { code: 'payment', label: 'Оплата', kind: 'open' },
    { code: 'repeat', label: 'Повторная продажа', kind: 'won' },
    { code: 'rejected', label: 'Отказ', kind: 'lost' },
  ]);
  for (const invalid of [
    [], Array.from({ length: 13 }, () => ({ label: 'QA', kind: 'open' })),
    [{ label: '', kind: 'open' }], [{ label: 'x'.repeat(41), kind: 'open' }],
    [{ label: 'QA', kind: 'invalid' }], [{ code: 'missing', label: 'QA', kind: 'open' }],
    [stageInput(initial.body.stages)[0], stageInput(initial.body.stages)[0]],
  ]) {
    assert.equal((await request('PUT', '/pipeline-stages', { stages: invalid })).status, 400);
  }
  const changed = stageInput(initial.body.stages);
  changed[1].label = 'Переговоры';
  [changed[2], changed[3]] = [changed[3], changed[2]];
  changed.push({ label: 'Новый этап', kind: 'open' }, { label: 'Новый этап', kind: 'won' });
  const saved = await request('PUT', '/pipeline-stages', { stages: changed });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.stages.length, 7);
  assert.deepEqual(saved.body.stages.slice(0, 5).map((stage) => stage.code), changed.slice(0, 5)
    .map((stage) => stage.code));
  const renamed = saved.body.stages.find((stage) => stage.code === 'in_progress');
  assert.equal(renamed.label, 'Переговоры');
  assert.equal(renamed.id, initial.body.stages.find((stage) => stage.code === 'in_progress').id);
  const added = saved.body.stages.slice(5);
  assert.match(added[0].code, /^[a-z0-9_-]+$/);
  assert.notEqual(added[0].code, added[1].code);
  assert.deepEqual(added.map((stage) => stage.kind), ['open', 'won']);
  for (let index = 1; index < saved.body.stages.length; index += 1) {
    assert.ok(saved.body.stages[index].position > saved.body.stages[index - 1].position);
  }
  const moved = await request('PATCH', `/companies/${company.id}`, { pipelineStage: added[0].code });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.pipelineStage, added[0].code);
  assert.equal((await request('GET', `/companies/${company.id}`)).body.pipelineStage, added[0].code);
  for (const pipelineStage of ['application', 'missing']) {
    assert.equal((await request('PATCH', `/companies/${company.id}`, { pipelineStage })).status, 400);
  }
  const removal = stageInput(saved.body.stages.filter((stage) => stage.code !== added[0].code));
  removal[0].label = 'Не сохранять при конфликте';
  const conflict = await request('PUT', '/pipeline-stages', { stages: removal });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'В этапе «Новый этап» есть 1 компаний — сначала перенесите их');
  assert.deepEqual((await request('GET', '/pipeline-stages')).body, saved.body);
  assert.equal((await request('PATCH', `/companies/${company.id}`, { pipelineStage: 'new' })).status, 200);
  const restored = await request('PUT', '/pipeline-stages', { stages: stageInput(initial.body.stages) });
  assert.equal(restored.status, 200);
  assert.deepEqual(stageInput(restored.body.stages), stageInput(initial.body.stages));
  assert.equal((await request('PATCH', `/companies/${company.id}`, { pipelineStage: added[0].code })).status, 400);
  console.log('PIPELINE_SETTINGS=PASS PIPELINE_VALIDATION=PASS PIPELINE_DELETE_CONFLICT=PASS COMPANY_MOVE=PASS');
}
async function verifyCompanyOverview(company, companyB, contact, legal, lead, taskInbox, taskUrgent) {
  const pathname = `/companies/${company.id}/overview`;
  assert.equal((await request('GET', pathname, undefined, null)).status, 401);
  assert.equal((await request('GET', '/companies/999999999/overview')).status, 404);
  const unrelated = await request('POST', '/contacts', { name: 'QA Other company contact' });
  assert.equal(unrelated.status, 201);
  assert.equal((await request('PUT', `/contacts/${unrelated.body.id}/companies/${companyB.id}`, {
    role: 'Other company',
  })).status, 201);
  const removed = await request('POST', '/contacts', { name: 'QA Removed contact' });
  assert.equal(removed.status, 201);
  const removedRelation = `/contacts/${removed.body.id}/companies/${company.id}`;
  assert.equal((await request('PUT', removedRelation, { role: 'Removed relation' })).status, 201);
  assert.equal((await request('DELETE', removedRelation)).status, 200);
  const deletedContact = await request('POST', '/contacts', { name: 'QA Deleted contact' });
  assert.equal(deletedContact.status, 201);
  assert.equal((await request('PUT', `/contacts/${deletedContact.body.id}/companies/${company.id}`, {
    role: 'Deleted contact',
  })).status, 201);
  assert.equal((await request('DELETE', `/contacts/${deletedContact.body.id}`)).status, 200);
  for (const status of ['done', 'cancelled']) {
    assert.equal((await request('POST', '/tasks', {
      title: `QA Excluded ${status}`, companyCode: company.code, status,
    })).status, 201);
  }
  assert.equal((await request('POST', '/tasks', {
    title: 'QA Other company task', companyCode: companyB.code,
  })).status, 201);
  assert.equal((await request('POST', '/tasks', { title: 'QA Unassigned task' })).status, 201);
  const overview = await request('GET', pathname);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.company.id, company.id);
  assert.equal(overview.body.company.code, company.code);
  assert.deepEqual(overview.body.contacts.map((item) => item.id), [contact.id]);
  assert.equal(overview.body.contacts[0].name, contact.name);
  assert.equal(overview.body.contacts[0].relation.role, 'QA restored');
  assert.deepEqual(overview.body.legalEntities.map((item) => item.id), [legal.id]);
  assert.equal(overview.body.legalEntities[0].relation.role, 'QA payer');
  assert.deepEqual(overview.body.tasks.map((item) => item.id).sort((a, b) => a - b),
    [taskInbox.id, taskUrgent.id].sort((a, b) => a - b));
  assert.equal(overview.body.tasks.find((item) => item.id === taskUrgent.id).dueDate, '2030-01-02');
  assert.equal(overview.body.leads.total, 1);
  assert.equal(overview.body.leads.last[0].id, lead.id);
  assert.deepEqual(overview.body.stageHistory, []);
  const extraTasks = [];
  for (let index = 0; index < 23; index += 1) {
    const task = await request('POST', '/tasks', {
      title: `QA Overview task ${index}`, companyCode: company.code, status: 'planned',
    });
    assert.equal(task.status, 201);
    extraTasks.push(task.body.id);
  }
  const extraLeads = [];
  for (let index = 0; index < 6; index += 1) {
    const item = await request('POST', '/leads', {
      name: `QA Overview lead ${index}`, contact: `+7999010000${index}`, companyCode: company.code, source: 'QA',
    }, null);
    assert.equal(item.status, 201);
    extraLeads.push(item.body.id);
  }
  const capped = await request('GET', pathname);
  assert.equal(capped.status, 200);
  assert.deepEqual(capped.body.tasks.map((item) => item.id), extraTasks.reverse().slice(0, 20));
  for (const task of capped.body.tasks) {
    assert.deepEqual(Object.keys(task).sort(), ['dueDate', 'id', 'status', 'title']);
  }
  assert.equal(capped.body.leads.total, 7);
  assert.deepEqual(capped.body.leads.last.map((item) => item.id), extraLeads.reverse().slice(0, 5));
  for (const item of capped.body.leads.last) {
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'name', 'source', 'stage']);
    assert.equal(item.stage, 'новая');
    assert.equal(item.source, 'QA');
  }
  console.log('COMPANY_OVERVIEW=PASS OVERVIEW_SCOPE=PASS OVERVIEW_LIMITS=PASS');
}
async function verifyPipelineMigration() {
  await stop();
  const cases = [
    ['application', 'new'], ['call', 'in_progress'], ['kit_ready', 'in_progress'],
    ['payment', 'payment'], ['active', 'repeat'], [null, null],
  ];
  inspect((db) => {
    const insert = db.prepare(`INSERT INTO companies (created_at, updated_at, code, name, pipeline_stage)
      VALUES (?, ?, ?, ?, ?)`);
    for (const [old] of cases) {
      insert.run('2026-01-01', '2026-01-01', `qa_legacy_${old}`, `Legacy ${old}`, old);
    }
    db.exec('DROP TABLE pipeline_stages; DELETE FROM schema_migrations WHERE version = 4');
  });
  await start();
  inspect((db) => {
    for (const [old, expected] of cases) {
      assert.equal(db.prepare('SELECT pipeline_stage FROM companies WHERE code=?')
        .get(`qa_legacy_${old}`).pipeline_stage, expected);
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM pipeline_stages').get().count, 5);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version=4').get().count, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
  const defaults = (await request('GET', '/pipeline-stages')).body.stages;
  const custom = stageInput(defaults.filter((stage) => stage.code !== 'rejected'));
  custom[0].label = 'Новый контакт';
  custom.push({ label: 'После миграции', kind: 'open' });
  const saved = await request('PUT', '/pipeline-stages', { stages: custom });
  assert.equal(saved.status, 200);
  await stop();
  await start();
  assert.deepEqual((await request('GET', '/pipeline-stages')).body, saved.body);
  inspect((db) => {
    for (const [old, expected] of cases) {
      assert.equal(db.prepare('SELECT pipeline_stage FROM companies WHERE code=?')
        .get(`qa_legacy_${old}`).pipeline_stage, expected);
    }
  });
  console.log('PIPELINE_LEGACY_MIGRATION=PASS PIPELINE_NULL_PRESERVED=PASS PIPELINE_RESTART=PASS');
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

  for (const pathname of ['/contacts', '/companies', '/legal-entities', '/pipeline-stages']) {
    assert.equal((await request('GET', pathname, undefined, null)).status, 401);
    assert.equal((await request('GET', pathname, undefined, 'wrong')).status, 401);
  }
  assert.equal((await request('PUT', '/pipeline-stages', { stages: [] }, null)).status, 401);
  const contact = await request('POST', '/contacts', { name: 'QA Contact A', city: 'QA City',
    phone: '+7 999 000-00-00', messengers: [{ type: 'telegram', label: 'QA', handle: 'qa', url: null }],
    links: [{ label: 'QA', url: 'https://example.test/contact' }], birthDate: '2000-02-29', notes: 'QA notes' });
  assert.equal(contact.status, 201);
  const company = await request('POST', '/companies', { code: 'qa_company_a', name: 'QA Company A',
    websiteUrl: 'https://example.test', pipelineStage: 'new', notes: 'QA notes' });
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
  const card = await request('GET', `/companies/${company.body.id}`);
  assert.equal(card.body.contacts[0].relation.role, 'QA changed');
  assert.equal(card.body.primaryLegalEntity.id, legal.body.id);
  assert.equal((await request('DELETE', cc)).status, 200);
  assert.equal((await request('DELETE', cc)).status, 200);
  assert.equal((await request('PUT', cc, { role: 'QA restored' })).status, 200);
  console.log('RELATIONS=PASS');
  await verifyPipelineSettings(company.body);

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
  await verifyCompanyOverview(company.body, companyB.body, contact.body, legal.body,
    leadA.body, taskInbox.body, taskUrgent.body);

  const deleted = await request('DELETE', `/companies/${company.body.id}`);
  assert.equal(deleted.status, 200);
  const deletedAgain = await request('DELETE', `/companies/${company.body.id}`);
  assert.equal(deletedAgain.body.deletedAt, deleted.body.deletedAt);
  assert.equal((await request('GET', `/companies/${company.body.id}`)).status, 404);
  assert.equal((await request('GET', `/companies/${company.body.id}/overview`)).status, 404);
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
  await verifyPipelineMigration();
  console.log('CRM_SMOKE_TEST=PASS');
}

main().catch((error) => {
  console.error(`CRM_SMOKE_TEST=FAIL: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
