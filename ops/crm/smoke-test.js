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
  return stages.map(({ code, label, kind, attention }) => ({ code, label, kind, attention }));
}
async function verifyPipelineSettings(company) {
  const pipelines = await request('GET', '/pipelines');
  assert.equal(pipelines.status, 200);
  assert.deepEqual(pipelines.body.pipelines.map((pipeline) => pipeline.code), ['sale', 'service']);
  const pipelineInput = pipelines.body.pipelines.map(({ code, label }) => ({ code, label })).reverse();
  pipelineInput[0].label = 'QA Сопровождение';
  pipelineInput.push({ label: 'QA Воронка' }, { label: 'QA Воронка' });
  const savedPipelines = await request('PUT', '/pipelines', { pipelines: pipelineInput });
  assert.equal(savedPipelines.status, 200);
  assert.deepEqual(savedPipelines.body.pipelines.slice(0, 2).map((pipeline) => pipeline.code), ['service', 'sale']);
  assert.equal(savedPipelines.body.pipelines[0].label, 'QA Сопровождение');
  assert.equal(savedPipelines.body.pipelines[0].id, pipelines.body.pipelines[1].id);
  assert.notEqual(savedPipelines.body.pipelines[2].code, savedPipelines.body.pipelines[3].code);
  for (const invalid of [[], [{ code: 'missing', label: 'QA' }], [{ label: '' }]]) {
    assert.equal((await request('PUT', '/pipelines', { pipelines: invalid })).status, 400);
  }
  assert.deepEqual((await request('GET', '/pipelines')).body, savedPipelines.body);
  const initial = await request('GET', '/pipeline-stages');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, (await request('GET', '/pipeline-stages?pipeline=sale')).body);
  assert.deepEqual(initial.body.stages.map(({ code, label, kind }) => ({ code, label, kind })), [
    { code: 'new', label: 'Новый', kind: 'open' },
    { code: 'contact', label: 'Контакт', kind: 'open' },
    { code: 'meeting', label: 'Встреча', kind: 'open' },
    { code: 'pilot', label: 'Пилот', kind: 'open' },
    { code: 'paid', label: 'Оплата', kind: 'won' },
    { code: 'rejected', label: 'Отказ', kind: 'lost' },
  ]);
  const service = await request('GET', '/pipeline-stages?pipeline=service');
  assert.equal(service.status, 200);
  assert.deepEqual(service.body.stages.map((stage) => stage.code),
    ['onboarding', 'active', 'renewal', 'upsell', 'risk', 'churned']);
  assert.equal(Boolean(service.body.stages.find((stage) => stage.code === 'risk').attention), true);
  assert.equal(service.body.stages.find((stage) => stage.code === 'churned').kind, 'lost');
  assert.equal((await request('GET', '/pipeline-stages?pipeline=missing')).status, 400);
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
  assert.equal(saved.body.stages.length, 8);
  assert.deepEqual(saved.body.stages.slice(0, 6).map((stage) => stage.code), changed.slice(0, 6)
    .map((stage) => stage.code));
  const renamed = saved.body.stages.find((stage) => stage.code === 'contact');
  assert.equal(renamed.label, 'Переговоры');
  assert.equal(renamed.id, initial.body.stages.find((stage) => stage.code === 'contact').id);
  const added = saved.body.stages.slice(6);
  assert.match(added[0].code, /^[a-z0-9_-]+$/);
  assert.notEqual(added[0].code, added[1].code);
  assert.deepEqual(added.map((stage) => stage.kind), ['open', 'won']);
  for (let index = 1; index < saved.body.stages.length; index += 1) {
    assert.ok(saved.body.stages[index].position > saved.body.stages[index - 1].position);
  }
  const moved = await request('PATCH', `/companies/${company.id}`, { pipelineStage: added[0].code });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.pipelineStage, added[0].code);
  assert.equal(moved.body.pipelines.sale.stage, added[0].code);
  assert.equal((await request('GET', `/companies/${company.id}`)).body.pipelineStage, added[0].code);
  for (const pipelineStage of ['application', 'missing', 'active']) {
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
  assert.deepEqual((await request('GET', '/pipeline-stages?pipeline=service')).body, service.body);
  const serviceChanged = stageInput(service.body.stages);
  serviceChanged.find((stage) => stage.code === 'risk').attention = false;
  serviceChanged[0].label = 'QA Внедрение';
  const savedService = await request('PUT', '/pipeline-stages?pipeline=service', { stages: serviceChanged });
  assert.equal(savedService.status, 200);
  assert.equal(Boolean(savedService.body.stages.find((stage) => stage.code === 'risk').attention), false);
  assert.deepEqual((await request('GET', '/pipeline-stages?pipeline=sale')).body, restored.body);
  assert.equal((await request('PUT', '/pipeline-stages?pipeline=service', {
    stages: stageInput(service.body.stages),
  })).status, 200);
  console.log('PIPELINES_SETTINGS=PASS PIPELINE_SCOPE=PASS PIPELINE_ATTENTION=PASS');
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
  assert.ok(overview.body.stageHistory.length >= 2);
  assert.ok(overview.body.stageHistory.every((entry) => entry.pipelineCode === 'sale'));
  assert.ok(overview.body.stageHistory.some((entry) => entry.toCode === 'new'));
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
async function createPipelineCompany(code, pipelineStage = 'new') {
  const created = await request('POST', '/companies', { code, name: `QA ${code}`, pipelineStage });
  assert.equal(created.status, 201);
  return created.body;
}
async function movePipeline(company, pipeline, stageCode, reason) {
  const moved = await request('PATCH', `/companies/${company.id}/pipeline`, { pipeline, stageCode, reason });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.company.pipelines[pipeline].stage, stageCode);
  return moved.body.company;
}
function dateOffset(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}
function backdateStage(company, pipeline, months) {
  const enteredAt = new Date();
  enteredAt.setUTCMonth(enteredAt.getUTCMonth() - months);
  inspect((db) => {
    db.prepare(`UPDATE company_pipeline_state SET entered_at=? WHERE company_id=?
      AND pipeline_id=(SELECT id FROM pipelines WHERE code=?)`).run(enteredAt.toISOString(), company.id, pipeline);
  });
}
async function verifyPipelineCompanies(contact) {
  const company = await createPipelineCompany('qa_pipeline_company');
  assert.equal(company.pipelines.sale.stage, 'new');
  assert.ok(Number.isFinite(Date.parse(company.pipelines.sale.enteredAt)));
  const pipelinePath = `/companies/${company.id}/pipeline`;
  const servicePath = `/companies/${company.id}/service`;
  for (const pathname of [pipelinePath, servicePath]) {
    assert.equal((await request('PATCH', pathname, {}, null)).status, 401);
    assert.equal((await request('PATCH', pathname, {}, 'wrong')).status, 401);
  }
  for (const invalid of [
    {}, { pipeline: 'missing', stageCode: 'new' }, { pipeline: 'sale', stageCode: 'active' },
    { pipeline: 'service', stageCode: 'paid' }, { pipeline: 'sale', stageCode: 'missing' },
    { pipeline: 'sale', stageCode: 'rejected' }, { pipeline: 'service', stageCode: 'churned', reason: ' ' },
    { pipeline: 'sale', stageCode: 'contact', unknown: true },
  ]) {
    assert.equal((await request('PATCH', pipelinePath, invalid)).status, 400);
  }
  assert.equal((await request('PATCH', `/companies/${company.id}`, { pipelineStage: 'rejected' })).status, 400);
  const paid = await movePipeline(company, 'sale', 'paid');
  assert.equal(paid.pipelineStage, 'paid');
  assert.equal(paid.pipelines.service.stage, 'onboarding');
  const active = await movePipeline(company, 'service', 'active');
  assert.equal(active.pipelines.sale.stage, 'paid');
  assert.equal(active.pipelineStage, 'paid');
  await movePipeline(company, 'sale', 'contact');
  await movePipeline(company, 'sale', 'paid');
  assert.equal((await request('GET', `/companies/${company.id}`)).body.pipelines.service.stage, 'active');
  const paidOnCreate = await createPipelineCompany('qa_pipeline_paid_create', 'paid');
  assert.equal(paidOnCreate.pipelines.service.stage, 'onboarding');
  const legacy = await createPipelineCompany('qa_pipeline_legacy_patch');
  const legacyPaid = await request('PATCH', `/companies/${legacy.id}`, { pipelineStage: 'paid' });
  assert.equal(legacyPaid.status, 200);
  assert.equal(legacyPaid.body.pipelines.sale.stage, 'paid');
  assert.equal(legacyPaid.body.pipelines.service.stage, 'onboarding');
  const legacyRejected = await request('PATCH', `/companies/${legacy.id}`, {
    pipelineStage: 'rejected', reason: 'QA Причина старого маршрута',
  });
  assert.equal(legacyRejected.status, 200);
  assert.equal(legacyRejected.body.pipelines.sale.stage, 'rejected');
  const service = {
    paidUntil: dateOffset(60), monthlyAmount: 12345.67, lastTouchAt: new Date().toISOString(),
    nextTouchAt: `${dateOffset(7)}T12:00:00.000Z`, clientOwnerContactId: contact.id,
  };
  const saved = await request('PATCH', servicePath, service);
  assert.equal(saved.status, 200);
  for (const [key, value] of Object.entries(service)) assert.equal(saved.body.company.service[key], value);
  assert.deepEqual(saved.body.company.service.clientOwnerContact, { id: contact.id, name: contact.name });
  inspect((db) => {
    db.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => db.prepare('UPDATE company_service SET client_owner_contact_id=? WHERE company_id=?')
      .run(999999999, company.id), /FOREIGN KEY constraint failed/);
    assert.throws(() => db.prepare(`UPDATE company_pipeline_state SET stage_code='onboarding'
      WHERE company_id=? AND pipeline_id=(SELECT id FROM pipelines WHERE code='sale')`).run(company.id),
    /FOREIGN KEY constraint failed/);
  });
  const listed = await request('GET', `/companies?q=${company.code}`);
  const listedCompany = listed.body.companies.find((item) => item.id === company.id);
  assert.deepEqual(listedCompany.service, saved.body.company.service);
  assert.deepEqual(listedCompany.pipelines, saved.body.company.pipelines);
  assert.deepEqual((await request('GET', `/companies/${company.id}/overview`)).body.company.service,
    saved.body.company.service);
  for (const invalid of [
    {}, { monthlyAmount: -1 }, { monthlyAmount: '10' }, { paidUntil: '2030-02-30' },
    { lastTouchAt: 'not a date' }, { nextTouchAt: '2030-02-30' }, { clientOwnerContactId: 999999999 },
    { clientOwnerContactId: -1 }, { clientOwnerContactId: contact.id, unknown: true },
  ]) {
    assert.equal((await request('PATCH', servicePath, invalid)).status, 400);
  }
  const staleOwner = await request('POST', '/contacts', { name: 'QA Deleted client owner' });
  assert.equal(staleOwner.status, 201);
  assert.equal((await request('DELETE', `/contacts/${staleOwner.body.id}`)).status, 200);
  assert.equal((await request('PATCH', servicePath, { clientOwnerContactId: staleOwner.body.id })).status, 400);
  const cleared = await request('PATCH', servicePath, {
    paidUntil: null, monthlyAmount: null, lastTouchAt: null, nextTouchAt: null, clientOwnerContactId: null,
  });
  assert.equal(cleared.status, 200);
  assert.ok(Object.values(cleared.body.company.service).every((value) => value === null));
  await movePipeline(company, 'sale', 'rejected', 'QA Отложенный бюджет');
  await movePipeline(company, 'service', 'churned', 'QA Завершён проект');
  const overview = await request('GET', `/companies/${company.id}/overview`);
  const history = overview.body.stageHistory;
  assert.ok(history.some((entry) => entry.pipelineCode === 'sale' && entry.fromCode === 'new'
    && entry.toCode === 'paid' && entry.by === 'user'));
  assert.ok(history.some((entry) => entry.pipelineCode === 'service' && entry.toCode === 'onboarding'
    && entry.by === 'auto'));
  assert.ok(history.some((entry) => entry.pipelineCode === 'sale' && entry.toCode === 'rejected'
    && entry.reason === 'QA Отложенный бюджет'));
  assert.ok(history.some((entry) => entry.pipelineCode === 'service' && entry.toCode === 'churned'
    && entry.reason === 'QA Завершён проект'));
  for (const entry of history) assert.ok(Number.isFinite(Date.parse(entry.at)));
  const historyLength = history.length;
  await movePipeline(company, 'service', 'churned', 'QA Завершён проект');
  assert.equal((await request('GET', `/companies/${company.id}/overview`)).body.stageHistory.length, historyLength);
  inspect((db) => {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
  console.log('COMPANY_PIPELINES=PASS SERVICE_FIELDS=PASS PIPELINE_REASONS=PASS PIPELINE_HISTORY=PASS');
}
async function verifyPipelineAutomation() {
  const defaults = await request('GET', '/pipeline-rules');
  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.body.rules, {
    silentDays: 14, renewalDays: 10, rejectedReturnMonths: 3, churnedReturnMonths: 6,
  });
  assert.equal((await request('PUT', '/pipeline-rules', defaults.body, null)).status, 401);
  for (const rules of [
    {}, { ...defaults.body.rules, silentDays: 0 }, { ...defaults.body.rules, silentDays: 1.5 },
    { ...defaults.body.rules, renewalDays: 3651 }, { ...defaults.body.rules, rejectedReturnMonths: 121 },
    { ...defaults.body.rules, churnedReturnMonths: '6' }, { ...defaults.body.rules, unknown: 2 },
  ]) {
    assert.equal((await request('PUT', '/pipeline-rules', { rules })).status, 400);
  }
  const rules = { silentDays: 10, renewalDays: 14, rejectedReturnMonths: 2, churnedReturnMonths: 3 };
  assert.equal((await request('PUT', '/pipeline-rules', { rules })).status, 200);
  assert.deepEqual((await request('GET', '/pipeline-rules')).body.rules, rules);
  const risk = await createPipelineCompany('qa_auto_risk', 'paid');
  const renewal = await createPipelineCompany('qa_auto_renewal', 'paid');
  const untouched = await createPipelineCompany('qa_auto_untouched', 'paid');
  for (const company of [risk, renewal, untouched]) await movePipeline(company, 'service', 'active');
  assert.equal((await request('PATCH', `/companies/${risk.id}/service`, {
    paidUntil: dateOffset(5), lastTouchAt: `${dateOffset(-30)}T12:00:00.000Z`,
  })).status, 200);
  assert.equal((await request('PATCH', `/companies/${renewal.id}/service`, {
    paidUntil: dateOffset(5), lastTouchAt: new Date().toISOString(),
  })).status, 200);
  assert.equal((await request('GET', '/pipeline-stages?pipeline=service')).status, 200);
  for (const [company, stage] of [[risk, 'risk'], [renewal, 'renewal'], [untouched, 'active']]) {
    const overview = await request('GET', `/companies/${company.id}/overview`);
    assert.equal(overview.body.company.pipelines.service.stage, stage);
    if (stage !== 'active') {
      assert.ok(overview.body.stageHistory.some((entry) => entry.pipelineCode === 'service'
        && entry.fromCode === 'active' && entry.toCode === stage && entry.by === 'auto'));
    }
  }
  const rejected = await createPipelineCompany('qa_auto_rejected');
  await movePipeline(rejected, 'sale', 'rejected', 'QA Позже');
  const churned = await createPipelineCompany('qa_auto_churned', 'paid');
  await movePipeline(churned, 'service', 'churned', 'QA Пауза');
  const returnTasks = async (company) => {
    const tasks = await request('GET', `/tasks?companyCode=${company.code}&source=pipeline`);
    assert.equal(tasks.status, 200);
    return tasks.body.tasks;
  };
  assert.equal((await request('GET', '/pipeline-stages')).status, 200);
  for (const company of [rejected, churned]) assert.equal((await returnTasks(company)).length, 0);
  backdateStage(rejected, 'sale', 4);
  backdateStage(churned, 'service', 5);
  assert.equal((await request('GET', '/pipeline-stages')).status, 200);
  for (const company of [rejected, churned]) {
    const tasks = await returnTasks(company);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, `Вернуться к ${company.name}`);
    assert.equal(tasks[0].assigneeRole, 'owner');
    assert.equal(tasks[0].source, 'pipeline');
    assert.equal((await request('PATCH', `/tasks/${tasks[0].id}`, { status: 'done' })).status, 200);
  }
  assert.equal((await request('GET', '/pipeline-stages')).status, 200);
  await stop();
  await start();
  assert.equal((await request('GET', '/pipeline-stages?pipeline=service')).status, 200);
  assert.deepEqual((await request('GET', '/pipeline-rules')).body.rules, rules);
  for (const company of [rejected, churned]) assert.equal((await returnTasks(company)).length, 1);
  await movePipeline(rejected, 'sale', 'contact');
  await movePipeline(rejected, 'sale', 'rejected', 'QA Следующая попытка');
  backdateStage(rejected, 'sale', 4);
  assert.equal((await request('GET', '/pipeline-stages')).status, 200);
  assert.equal((await returnTasks(rejected)).length, 2);
  assert.equal((await returnTasks(churned)).length, 1);
  assert.equal((await request('PUT', '/pipeline-rules', defaults.body)).status, 200);
  console.log('PIPELINE_RULES=PASS AUTO_RISK_PRIORITY=PASS AUTO_RENEWAL=PASS RETURN_TASK_DEDUP=PASS');
}
async function verifyPipelineMigration() {
  await stop();
  databasePath = path.join(directory, 'legacy-v4.sqlite');
  await start();
  await stop();
  const cases = [
    ['new', 'new'], ['in_progress', 'contact'], ['payment', 'paid'],
    ['repeat', 'paid'], ['rejected', 'rejected'], [null, null], ['qa_custom', 'qa_custom'],
    ['contact', ''], ['meeting', ''], ['pilot', ''], ['paid', ''], ['contact-2', 'contact-2'],
    ['qa_extra', 'qa_extra'],
  ];
  const migratedCodes = Object.fromEntries(cases);
  const collidingCodes = ['contact', 'meeting', 'pilot', 'paid'];
  inspect((db) => {
    db.exec(`
      DROP TABLE company_stage_history;
      DROP TABLE company_pipeline_state;
      DROP TABLE company_service;
      DROP TABLE pipeline_rules;
      DROP TABLE pipeline_stages;
      DROP TABLE pipelines;
      DELETE FROM schema_migrations WHERE version = 5;
      CREATE TABLE pipeline_stages (
        id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, label TEXT NOT NULL, position INTEGER NOT NULL,
        is_final INTEGER DEFAULT 0, kind TEXT CHECK(kind IN ('open','won','lost')) DEFAULT 'open',
        created_at TEXT, updated_at TEXT
      );
      DROP TABLE tasks;
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', company_code TEXT NOT NULL DEFAULT '',
        assignee_role TEXT NOT NULL DEFAULT 'synapse', assignee_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'inbox', priority TEXT NOT NULL DEFAULT 'normal',
        due_date TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual'
          CHECK(source IN ('manual','chat','telegram')), source_ref TEXT NOT NULL DEFAULT '',
        source_author TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT ''
      );
    `);
    const insertStage = db.prepare(`INSERT INTO pipeline_stages
      (code, label, position, kind, is_final, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const stages = [
      ['new', 'Новый', 'won'], ['in_progress', 'В работе', 'open'], ['payment', 'Оплата', 'open'],
      ['repeat', 'Повторная продажа', 'won'], ['rejected', 'Отказ', 'open'], ['qa_custom', 'Особый этап', 'open'],
      ['contact', 'QA Custom contact', 'lost'], ['meeting', 'QA Custom meeting', 'won'],
      ['pilot', 'QA Custom pilot', 'open'], ['paid', 'QA Custom paid', 'open'],
      ['contact-2', 'QA Existing suffix', 'open'],
      ['qa_extra', 'QA Twelfth stage', 'open'],
    ];
    for (const [position, [code, label, kind]] of stages.entries()) {
      insertStage.run(code, label, position, kind, kind === 'open' ? 0 : 1, '2026-01-01', '2026-01-01');
    }
    const insert = db.prepare(`INSERT INTO companies (created_at, updated_at, code, name, pipeline_stage)
      VALUES (?, ?, ?, ?, ?)`);
    for (const [old] of cases) {
      const now = new Date().toISOString();
      insert.run(now, now, `qa_legacy_${old}`, `Legacy ${old}`, old);
    }
    db.prepare(`INSERT INTO tasks (created_at, updated_at, title, company_code, source, source_ref,
      description, assignee_role, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('2026-01-01', '2026-01-02', 'Legacy task', 'qa_legacy_repeat', 'chat',
        'qa:legacy:task', 'Сохранить описание', 'owner', '2030-01-02');
  });
  await start();
  inspect((db) => {
    for (const code of collidingCodes) {
      const stage = db.prepare(`SELECT s.code, s.kind FROM pipeline_stages s
        JOIN pipelines p ON p.id=s.pipeline_id WHERE p.code='sale' AND s.label=?`).get(`QA Custom ${code}`);
      assert.ok(stage, `Сохранён пользовательский этап ${code}`);
      assert.notEqual(stage.code, code);
      if (code === 'contact') assert.notEqual(stage.code, 'contact-2');
      assert.equal(stage.kind, code === 'contact' ? 'lost' : code === 'meeting' ? 'won' : 'open');
      migratedCodes[code] = stage.code;
    }
    for (const [old] of cases) {
      assert.equal(db.prepare('SELECT pipeline_stage FROM companies WHERE code=?')
        .get(`qa_legacy_${old}`).pipeline_stage, migratedCodes[old]);
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM pipelines').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version=4').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version=5').get().count, 1);
    for (const [code, kind] of [['new', 'won'], ['rejected', 'open']]) {
      assert.equal(db.prepare(`SELECT s.kind FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
        WHERE p.code='sale' AND s.code=?`).get(code).kind, kind);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const oldTask = db.prepare('SELECT * FROM tasks WHERE source_ref=?').get('qa:legacy:task');
    assert.equal(oldTask.title, 'Legacy task');
    assert.equal(oldTask.description, 'Сохранить описание');
    assert.equal(oldTask.source, 'chat');
    assert.equal(oldTask.assignee_role, 'owner');
    assert.equal(oldTask.due_date, '2030-01-02');
  });
  const migrated = (await request('GET', '/companies?limit=200')).body.companies;
  const repeated = migrated.find((company) => company.code === 'qa_legacy_repeat');
  assert.equal(repeated.pipelines.sale.stage, 'paid');
  assert.equal(repeated.pipelines.service.stage, 'active');
  const nullStage = migrated.find((company) => company.code === 'qa_legacy_null');
  assert.equal(nullStage.pipelineStage, null);
  assert.equal(nullStage.pipelines.sale, undefined);
  const customCompany = migrated.find((company) => company.code === 'qa_legacy_qa_custom');
  assert.equal(customCompany.pipelines.sale.stage, 'qa_custom');
  for (const code of collidingCodes) {
    const company = migrated.find((item) => item.code === `qa_legacy_${code}`);
    assert.equal(company.pipelines.sale.stage, migratedCodes[code]);
  }
  const payment = migrated.find((company) => company.code === 'qa_legacy_payment');
  assert.equal(payment.pipelines.service, undefined);
  const paymentOverview = (await request('GET', `/companies/${payment.id}/overview`)).body;
  const saleHistoryCount = paymentOverview.stageHistory.filter((entry) => entry.pipelineCode === 'sale').length;
  const paidAgain = await request('PATCH', `/companies/${payment.id}`, { pipelineStage: 'paid' });
  assert.equal(paidAgain.status, 200);
  assert.equal(paidAgain.body.pipelines.service.stage, 'onboarding');
  const afterPaid = (await request('GET', `/companies/${payment.id}/overview`)).body;
  assert.equal(afterPaid.stageHistory.filter((entry) => entry.pipelineCode === 'sale').length, saleHistoryCount);
  const pipelineTask = await request('POST', '/tasks', {
    title: 'QA Migrated pipeline task', companyCode: repeated.code, source: 'pipeline',
  });
  assert.equal(pipelineTask.status, 201);
  assert.equal(pipelineTask.body.source, 'pipeline');
  const defaults = (await request('GET', '/pipeline-stages')).body.stages;
  assert.equal(defaults.length, 13);
  assert.equal(defaults.find((stage) => stage.code === 'qa_custom').label, 'Особый этап');
  const custom = stageInput(defaults);
  custom[0].label = 'Новый контакт';
  assert.equal((await request('PUT', '/pipeline-stages', {
    stages: [...custom, { label: 'Не увеличивать превышение', kind: 'open' }],
  })).status, 400);
  const saved = await request('PUT', '/pipeline-stages', { stages: custom });
  assert.equal(saved.status, 200);
  await stop();
  await start();
  assert.deepEqual((await request('GET', '/pipeline-stages')).body, saved.body);
  inspect((db) => {
    for (const [old] of cases) {
      assert.equal(db.prepare('SELECT pipeline_stage FROM companies WHERE code=?')
        .get(`qa_legacy_${old}`).pipeline_stage, migratedCodes[old]);
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM tasks').get().count, 2);
    for (const [code, kind] of [['new', 'won'], ['rejected', 'open']]) {
      assert.equal(db.prepare(`SELECT s.kind FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
        WHERE p.code='sale' AND s.code=?`).get(code).kind, kind);
    }
  });
  console.log('PIPELINE_V4_MIGRATION=PASS PIPELINE_NULL_PRESERVED=PASS PIPELINE_CUSTOM_PRESERVED=PASS');
  console.log('PIPELINE_CODE_COLLISIONS=PASS MIGRATED_PAID_ONBOARDING=PASS MIGRATED_STAGE_LIMIT=PASS');
  console.log('MIGRATED_CUSTOM_KINDS=PASS');
  console.log('PIPELINE_RESTART=PASS LEGACY_TASKS_PRESERVED=PASS TASK_PIPELINE_SOURCE=PASS');
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

  for (const pathname of ['/contacts', '/companies', '/legal-entities', '/pipeline-stages',
    '/pipelines', '/pipeline-rules']) {
    assert.equal((await request('GET', pathname, undefined, null)).status, 401);
    assert.equal((await request('GET', pathname, undefined, 'wrong')).status, 401);
  }
  assert.equal((await request('PUT', '/pipeline-stages', { stages: [] }, null)).status, 401);
  assert.equal((await request('PUT', '/pipelines', { pipelines: [] }, null)).status, 401);
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
  await verifyPipelineCompanies(contact.body);
  await verifyPipelineAutomation();

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
