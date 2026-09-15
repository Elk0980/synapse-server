'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const net = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { hashPassword } = require('./passwords');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(base, method, pathname, body, session, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (session) {
    headers.Cookie = session.cookie;
    if (session.csrf !== undefined) headers['X-CSRF-Token'] = session.csrf;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('CRM proxy restricts pipelines to the owner and preserves company-scoped editing', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-crm-permissions-'));
  const children = [];
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const password = 'QA content CRM password';
  const databasePath = path.join(directory, 'content.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    const auth = createAuthStore(db, `owner:owner:${hashPassword(password)}`);
    const owner = auth.getByLogin('owner');
    for (const [login, companies, permissions] of [
      ['editor', ['alvi'], ['crm.view', 'crm.edit']],
      ['mover', ['alvi', 'avokado'], ['crm.view', 'crm.edit']],
      ['target_editor', ['avokado'], ['crm.view', 'crm.edit']],
      ['observer', ['alvi', 'avokado'], ['crm.view']],
      ['viewer', ['alvi'], ['analytics.view']],
    ]) {
      const user = auth.create(owner.id, { login, displayName: login, password }, hashPassword(password));
      auth.updateAccess(owner.id, user.id, companies, permissions);
    }
  } finally { db.close(); }

  const apiKey = randomBytes(24).toString('hex');
  const outboundMarker = path.join(directory, 'unexpected-outbound.txt');
  const outboundGuard = path.join(directory, 'deny-outbound.cjs');
  // The real CRM still handles local HTTP requests. Any outgoing SMTP/DNS attempt
  // fails before reaching the network, without recording credentials or addresses.
  await writeFile(outboundGuard, `
    'use strict';
    const fs = require('node:fs');
    function blocked() {
      fs.appendFileSync(${JSON.stringify(outboundMarker)}, 'outbound attempted\\n');
      throw Object.assign(new Error('Outbound network disabled in permission test'), { code: 'QA_OUTBOUND_BLOCKED' });
    }
    require('node:net').Socket.prototype.connect = blocked;
    require('node:tls').connect = blocked;
    const dns = require('node:dns');
    for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx']) {
      dns[method] = blocked;
      if (dns.promises[method]) dns.promises[method] = blocked;
      if (dns.Resolver.prototype[method]) dns.Resolver.prototype[method] = blocked;
    }
  `);
  async function start(file, env, healthPath, preload) {
    const port = await freePort();
    const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), file], {
      env: { ...process.env, ...env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    children.push(child);
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Service failed: ${errors}`);
      try {
        const response = await fetch(`${base}${healthPath}`, { signal: AbortSignal.timeout(500) });
        await response.text();
        return base;
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    throw new Error(`Service did not start: ${errors}`);
  }
  const crmDatabasePath = path.join(directory, 'crm.sqlite');
  const crmBase = await start(path.join(__dirname, '../crm/server.js'), {
    DATABASE_PATH: crmDatabasePath, API_KEY: apiKey, RATE_LIMIT_MAX: '10000',
    LEADS_SMTP_HOST: 'smtp.yandex.ru', LEADS_SMTP_PORT: '465', LEADS_MAIL_FROM: '',
    LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '', LEADS_NOTIFY_EMAIL: '',
    LEADS_NOTIFY_EMAIL_ALVI: '', LEADS_NOTIFY_EMAIL_AVOKADO: '',
  }, '/contacts', outboundGuard);
  const base = await start(path.join(__dirname, 'server.js'), {
    DATABASE_PATH: databasePath, API_KEY: '', AUTH_USERS: '', SEED_DIR: directory,
    ASSETS_DIR: path.join(directory, 'assets'), SESSION_SECRET: randomBytes(32).toString('hex'),
    CRM_URL: crmBase, CRM_API_KEY: apiKey,
  }, '/health');
  async function login(name) {
    const loggedIn = await request(base, 'POST', '/content/login', { login: name, password });
    assert.equal(loggedIn.status, 200);
    const session = { cookie: loggedIn.headers.get('set-cookie').split(';')[0] };
    const identity = await request(base, 'GET', '/content/whoami', undefined, session);
    assert.equal(identity.status, 200);
    session.csrf = identity.body.csrfToken;
    return session;
  }
  const owner = await login('owner');
  const editor = await login('editor');
  const mover = await login('mover');
  const targetEditor = await login('target_editor');
  const observer = await login('observer');
  const viewer = await login('viewer');
  const crm = (session, method, pathname, body, headers) =>
    request(base, method, `/content/crm${pathname}`, body, session, headers);
  await t.test('email diagnostics require an owner session and expose only safe status', async () => {
    assert.equal((await crm(undefined, 'GET', '/email-status')).status, 401);
    for (const session of [editor, mover, targetEditor, observer, viewer]) {
      const result = await crm(session, 'GET', '/email-status');
      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'Настройки и диагностика почты доступны только владельцу');
    }
    const result = await crm(owner, 'GET', '/email-status');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.smtp.configured, false);
    assert.deepEqual(result.body.companies.map((company) => company.code), ['alvi', 'avokado']);
    assert.ok(result.body.companies.every((company) => company.recipientConfigured === false));
    assert.match(result.headers.get('cache-control'), /no-store/);
  });
  const qaEmailSettings = {
    provider: 'mailru', user: 'qa@example.test', password: 'QA_SENTINEL_SMTP_PASSWORD_NOT_A_REAL_CREDENTIAL',
    alviRecipient: 'alvi@example.test', avokadoRecipient: 'avokado@example.test',
  };
  function assertSafeEmailSettings(result) {
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), [
      'provider', 'user', 'alviRecipient', 'avokadoRecipient', 'passwordConfigured',
      'source', 'updatedAt', 'needsPassword',
    ].sort());
    assert.equal(typeof result.body.passwordConfigured, 'boolean');
    assert.equal(typeof result.body.needsPassword, 'boolean');
    assert.ok(!JSON.stringify(result.body).includes(qaEmailSettings.password));
    assert.match(result.headers.get('cache-control'), /no-store/);
  }
  function assertNoQueuedOrAttemptedEmail() {
    const crmDb = new DatabaseSync(crmDatabasePath, { readOnly: true });
    try {
      assert.equal(crmDb.prepare('SELECT COUNT(*) AS count FROM lead_email_outbox').get().count, 0);
    } finally { crmDb.close(); }
    assert.equal(existsSync(outboundMarker), false, 'CRM attempted an outbound connection');
  }
  await t.test('mail settings and connection checks reject unauthenticated and every non-owner role', async () => {
    for (const [method, pathname, body] of [
      ['GET', '/email-settings'],
      ['PUT', '/email-settings', qaEmailSettings],
      ['POST', '/email-settings/check', {}],
    ]) {
      assert.equal((await crm(undefined, method, pathname, body)).status, 401, `${method} ${pathname}`);
      for (const session of [editor, mover, targetEditor, observer, viewer]) {
        const result = await crm(session, method, pathname, body);
        assert.equal(result.status, 403, `${method} ${pathname}`);
        assert.equal(result.body.error, 'Настройки и диагностика почты доступны только владельцу');
      }
    }
    assertNoQueuedOrAttemptedEmail();
  });
  await t.test('owner GET exposes safe mail settings and rejected CSRF writes leave them unchanged', async () => {
    const before = await crm(owner, 'GET', '/email-settings');
    assertSafeEmailSettings(before);
    assert.equal(before.body.passwordConfigured, false);
    assert.equal(before.body.user, '');
    assert.equal(before.body.alviRecipient, '');
    assert.equal(before.body.avokadoRecipient, '');
    for (const session of [
      { cookie: owner.cookie },
      { cookie: owner.cookie, csrf: 'invalid-csrf-token' },
    ]) {
      const result = await crm(session, 'PUT', '/email-settings', qaEmailSettings);
      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'Некорректный CSRF-токен');
      const after = await crm(owner, 'GET', '/email-settings');
      assertSafeEmailSettings(after);
      assert.deepEqual(after.body, before.body);
    }
    assertNoQueuedOrAttemptedEmail();
  });
  await t.test('owner can save sentinel mail settings with CSRF without opening a connection or exposing the password', async () => {
    assertNoQueuedOrAttemptedEmail();
    const saved = await crm(owner, 'PUT', '/email-settings', qaEmailSettings);
    assertSafeEmailSettings(saved);
    assert.equal(saved.body.provider, 'mailru');
    assert.equal(saved.body.user, qaEmailSettings.user);
    assert.equal(saved.body.alviRecipient, qaEmailSettings.alviRecipient);
    assert.equal(saved.body.avokadoRecipient, qaEmailSettings.avokadoRecipient);
    assert.equal(saved.body.passwordConfigured, true);
    assert.equal(saved.body.needsPassword, false);
    assert.equal(saved.body.source, 'cabinet');
    const current = await crm(owner, 'GET', '/email-settings');
    assertSafeEmailSettings(current);
    assert.deepEqual(current.body, saved.body);
    assertNoQueuedOrAttemptedEmail();
  });
  const other = await crm(owner, 'POST', '/companies', { code: 'avokado', name: 'QA Other' });
  const own = await crm(owner, 'POST', '/companies', { code: 'alvi', name: 'QA ALVI', pipelineStage: 'new' });
  assert.equal(other.status, 201);
  assert.equal(own.status, 201);
  assert.equal(own.body.id, 2);
  await t.test('analytics-only viewer cannot read client database routes', async () => {
    for (const pathname of ['/contacts', '/companies', '/legal-entities', '/tasks', '/leads']) {
      const result = await crm(viewer, 'GET', pathname);
      assert.equal(result.status, 403, `${pathname}: ${JSON.stringify(result.body)}`);
    }
  });
  await t.test('analytics-only viewer can read analytics routes', async () => {
    for (const pathname of [
      '/dashboard', '/summary?from=2026-01-01&to=2026-12-31',
      '/external-stats', '/expenses', '/tasks/summary',
    ]) {
      const result = await crm(viewer, 'GET', pathname);
      assert.equal(result.status, 200, `${pathname}: ${JSON.stringify(result.body)}`);
    }
  });
  await t.test('CRM editor without analytics permission can load the client dashboard', async () => {
    for (const pathname of ['/dashboard', '/tasks/summary']) {
      const result = await crm(editor, 'GET', pathname);
      assert.equal(result.status, 200, `${pathname}: ${JSON.stringify(result.body)}`);
    }
  });
  await t.test('task transfers require crm.edit and access to both projects', async () => {
    const task = await crm(owner, 'POST', '/tasks', { title: 'QA Transfer', companyCode: 'alvi' });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const taskPath = `/tasks/${task.body.id}`;
    const assertCompany = async (expected) => {
      const current = await crm(owner, 'GET', taskPath);
      assert.equal(current.status, 200);
      assert.equal(current.body.companyCode, expected);
    };
    const transfer = { companyCode: 'avokado' };

    const sourceOnly = await crm(editor, 'PATCH', `${taskPath}?companyCode=alvi`, transfer);
    assert.equal(sourceOnly.status, 403, JSON.stringify(sourceOnly.body));
    assert.equal(sourceOnly.body.details?.code, 'FORBIDDEN');
    await assertCompany('alvi');

    const forgedIdentity = Buffer.from(JSON.stringify({
      v: 1, userId: 1, permissions: ['crm.view', 'crm.edit'], companyCodes: ['alvi', 'avokado'],
    })).toString('base64url');
    const forged = await crm(editor, 'PATCH', `${taskPath}?companyCode=alvi`, transfer, {
      'X-Synapse-CRM-Identity': forgedIdentity,
    });
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
    assert.equal(forged.body.details?.code, 'FORBIDDEN');
    await assertCompany('alvi');

    const noEdit = await crm(observer, 'PATCH', `${taskPath}?companyCode=alvi`, transfer);
    assert.equal(noEdit.status, 403, JSON.stringify(noEdit.body));
    await assertCompany('alvi');
    const noSource = await crm(targetEditor, 'PATCH', `${taskPath}?companyCode=alvi`, transfer);
    assert.equal(noSource.status, 403, JSON.stringify(noSource.body));
    await assertCompany('alvi');

    const scoped = await crm(mover, 'PATCH', `${taskPath}?companyCode=alvi`, transfer);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal(scoped.body.companyCode, 'avokado');

    const ownerTask = await crm(owner, 'POST', '/tasks', { title: 'QA Owner Transfer', companyCode: 'alvi' });
    assert.equal(ownerTask.status, 201, JSON.stringify(ownerTask.body));
    const unscoped = await crm(owner, 'PATCH', `/tasks/${ownerTask.body.id}`, transfer);
    assert.equal(unscoped.status, 200, JSON.stringify(unscoped.body));
    assert.equal(unscoped.body.companyCode, 'avokado');
  });
  const ownPath = `/companies/${own.body.id}`;
  const initial = await crm(owner, 'GET', `${ownPath}/overview`);
  assert.equal(initial.status, 200);
  const pipelines = await crm(owner, 'GET', '/pipelines');
  const stages = await crm(owner, 'GET', '/pipeline-stages');
  const rules = await crm(owner, 'GET', '/pipeline-rules');
  const routes = [
    ['GET', '/pipelines'],
    ['PUT', '/pipelines', { pipelines: pipelines.body.pipelines.map(({ code, label }) => ({ code, label })) }],
    ['GET', '/pipeline-stages'],
    ['PUT', '/pipeline-stages', { stages: stages.body.stages.map(
      ({ code, label, kind, attention }) => ({ code, label, kind, attention })) }],
    ['GET', '/pipeline-rules'], ['PUT', '/pipeline-rules', rules.body],
    ['GET', `${ownPath}/overview`],
    ['PATCH', `${ownPath}/pipeline`, { pipeline: 'sale', stageCode: 'contact' }],
    ['PATCH', `${ownPath}/pipeline`, { pipeline: 'service', stageCode: 'active' }],
    ['PATCH', `${ownPath}/service`, { monthlyAmount: 1234 }],
    ['PATCH', ownPath, { pipelineStage: 'paid' }],
  ];
  for (const [method, pathname, body] of routes) {
    await t.test(`non-owner receives 403: ${method} ${pathname} ${body?.pipeline || ''}`, async () => {
      for (const session of [editor, viewer]) {
        const result = await crm(session, method, `${pathname}?companyCode=alvi`, body);
        assert.equal(result.status, 403, JSON.stringify(result.body));
      }
    });
  }
  await t.test('editor cannot set a legacy pipeline stage during company creation', async () => {
    const result = await crm(editor, 'POST', '/companies?companyCode=alvi',
      { code: 'alvi', name: 'QA', pipelineStage: 'paid' });
    assert.equal(result.status, 403);
  });
  await t.test('external statistics are restricted to the assigned company', async () => {
    const stats = (companyCode, visits) => ({
      source: 'qa-proxy-permissions', companyCode,
      rows: [{ date: '2026-09-07', visits }],
    });
    assert.equal((await crm(owner, 'POST', '/external-stats', stats('alvi', 11))).status, 200);
    assert.equal((await crm(owner, 'POST', '/external-stats', stats('avokado', 22))).status, 200);

    const ownStats = await crm(editor, 'GET', '/external-stats');
    assert.equal(ownStats.status, 200, JSON.stringify(ownStats.body));
    assert.ok(ownStats.body.rows.length > 0);
    assert.ok(ownStats.body.rows.every((row) => row.companyCode === 'alvi'));

    const foreignStats = await crm(editor, 'GET', '/external-stats?companyCode=avokado');
    assert.equal(foreignStats.status, 403, JSON.stringify(foreignStats.body));

    const foreignWrite = await crm(editor, 'POST', '/external-stats', stats('avokado', 33));
    assert.equal(foreignWrite.status, 403, JSON.stringify(foreignWrite.body));
  });
  await t.test('company IDs and query variants cannot bypass the owner check', async () => {
    for (const company of [own.body, other.body]) {
      for (const query of ['', '?companyCode=ALVI', '?companyCode=alvi&companyCode=avokado']) {
        for (const [method, suffix, body] of [
          ['GET', 'overview'],
          ['PATCH', 'pipeline', { pipeline: 'sale', stageCode: 'meeting' }],
          ['PATCH', 'service', { monthlyAmount: 99 }],
        ]) {
          const result = await crm(editor, method, `/companies/${company.id}/${suffix}${query}`, body);
          assert.equal(result.status, 403, `${method} ${suffix}${query}`);
        }
      }
    }
    assert.deepEqual((await crm(owner, 'GET', `${ownPath}/overview`)).body, initial.body);
  });
  await t.test('owner can read and update every protected route', async () => {
    for (const [method, pathname, body] of routes) {
      const result = await crm(owner, method, pathname, body);
      assert.equal(result.status, 200, `${method} ${pathname}: ${JSON.stringify(result.body)}`);
    }
  });
  await t.test('editor can edit only owned company cards and scoped contacts', async () => {
    assert.equal((await crm(editor, 'PATCH', `${ownPath}?companyCode=alvi`, {
      name: 'Forbidden self edit',
    })).status, 403);
    assert.equal((await crm(editor, 'DELETE', `${ownPath}?companyCode=alvi`)).status, 403);
    const supplier = await crm(editor, 'POST', '/companies?companyCode=alvi', {
      code: 'alvi-supplier', name: 'QA Supplier',
    });
    assert.equal(supplier.status, 201);
    const changed = await crm(editor, 'PATCH',
      `/companies/${supplier.body.id}?companyCode=alvi`, { name: 'QA Updated' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.name, 'QA Updated');
    assert.equal((await crm(editor, 'PATCH', `/companies/${other.body.id}?companyCode=alvi`,
      { name: 'Forbidden' })).status, 403);
    const contact = await crm(editor, 'POST', '/contacts?companyCode=alvi', { name: 'QA Scoped' });
    assert.equal(contact.status, 201);
    assert.equal((await crm(editor, 'GET', `/contacts/${contact.body.id}?companyCode=alvi`)).status, 200);
    assert.equal((await crm(editor, 'DELETE', `/contacts/${contact.body.id}?companyCode=alvi`)).status, 200);
    assert.equal((await crm(editor, 'GET', `/contacts/${contact.body.id}?companyCode=alvi`)).status, 404);
  });
  await t.test('contact creation links an existing or new company atomically within the permitted base', async () => {
    const created = await crm(editor,'POST','/contacts?companyCode=alvi',{
      name:'QA Employee with employer', companyLink:{newCompany:{name:'QA Inline Employer',city:'Иркутск'},role:'Директор'}
    });
    assert.equal(created.status,201,JSON.stringify(created.body));
    const employer=created.body.companies.find(c=>c.name==='QA Inline Employer');
    assert.ok(employer); assert.equal(employer.relation.role,'Директор');
    const card=await crm(editor,'GET',`/contacts/${created.body.id}?companyCode=alvi`);
    assert.equal(card.status,200);assert.ok(card.body.companies.some(c=>c.id===employer.id));
    const existing=await crm(editor,'POST','/contacts?companyCode=alvi',{
      name:'QA Second employee',companyLink:{companyId:employer.id,role:'Сотрудник'}
    });
    assert.equal(existing.status,201);assert.ok(existing.body.companies.some(c=>c.id===employer.id));
    const sameBase=await crm(editor,'POST','/contacts?companyCode=alvi',{
      name:'QA Base employee',companyLink:{companyId:own.body.id,role:'Сотрудник'}
    });
    assert.equal(sameBase.status,201);
    assert.equal((await crm(editor,'PUT',`/contacts/${sameBase.body.id}/companies/${own.body.id}?companyCode=alvi`,{role:'Директор'})).status,200);
    const beforeContacts=(await crm(editor,'GET','/contacts?companyCode=alvi')).body.pagination.total;
    const beforeCompanies=(await crm(editor,'GET','/companies?companyCode=alvi')).body.pagination.total;
    for(const companyLink of [
      {companyId:other.body.id,role:'Сотрудник'},
      {newCompany:{name:'',city:'Иркутск'},role:'Сотрудник'},
      {newCompany:{name:'Forbidden field',pipelineStage:'new'},role:'Сотрудник'},
      {newCompany:{name:'Invalid role'},role:''}
    ]) {
      const failed=await crm(editor,'POST','/contacts?companyCode=alvi',{name:'Must not persist',companyLink});
      assert.ok(failed.status>=400,JSON.stringify(failed.body));
    }
    assert.equal((await crm(editor,'GET','/contacts?companyCode=alvi')).body.pagination.total,beforeContacts);
    assert.equal((await crm(editor,'GET','/companies?companyCode=alvi')).body.pagination.total,beforeCompanies);
    assert.equal((await crm(observer,'POST','/contacts?companyCode=alvi',{name:'Forbidden',companyLink:{newCompany:{name:'Forbidden'},role:'Сотрудник'}})).status,403);
  });

  await t.test('deal gates, evidence, owner override and configurable stages',async()=>{
    const company=await crm(editor,'POST','/companies?companyCode=alvi',{code:'qa-orders-customer',name:'Orders customer'});
    assert.equal(company.status,201);
    const create=()=>crm(editor,'POST','/deals?companyCode=alvi',{companyId:company.body.id,title:'Implementation',requestId:'qa-order-1'});
    let result=await create();assert.equal(result.status,201,JSON.stringify(result.body));let d=result.body;
    assert.equal((await create()).body.id,d.id);
    const second=await crm(editor,'POST','/deals?companyCode=alvi',{companyId:company.body.id,title:'Second order'});assert.notEqual(second.body.id,d.id);
    const path=`/deals/${d.id}?companyCode=alvi`;
    assert.equal((await crm(targetEditor,'GET',`/deals/${d.id}?companyCode=avokado`)).status,404);
    assert.equal((await crm(observer,'PATCH',path,{version:d.version,title:'Forbidden'})).status,403);
    assert.equal((await crm(editor,'PATCH',path,{version:d.version,stage:'paid'})).status,409);
    assert.equal((await crm(editor,'PATCH',path,{version:d.version,stage:'paid',override:{accepted:true,reason:'Test exception'}})).status,403);
    result=await crm(owner,'PATCH',path,{version:d.version,stage:'paid',override:{accepted:true,reason:'Owner approved exception'}});
    assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.history[0].override,true);assert.equal(result.body.history[0].missing.length,2);
    d=second.body;const secondPath=`/deals/${d.id}?companyCode=alvi`;
    for(const kind of ['contract','receipt'])assert.equal((await crm(editor,'POST',`/deals/${d.id}/files?companyCode=alvi`,{kind,name:kind+'.pdf',mime:'application/pdf',base64:Buffer.from('%PDF-1.4 QA').toString('base64')})).status,200);
    result=await crm(editor,'PATCH',secondPath,{version:d.version,stage:'paid'});assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal((await crm(editor,'PATCH',secondPath,{version:d.version,title:'Stale'})).status,409);
    const config=await crm(owner,'GET','/deals/criteria?companyCode=alvi');assert.equal(config.status,200);
    const rows=config.body.stages.map(s=>({code:s.code,label:s.label,kind:s.kind,attention:!!s.attention,color:'#44aa99',required:s.rules.required,manual:s.rules.manual,steps:['Позвонить клиенту'],done:'Согласован следующий шаг'}));
    rows[0].label='Новый запрос';rows.push({label:'Проверка результата',kind:'open',color:'#ddbb44',required:[],manual:['Клиент подтвердил результат'],steps:['Проверить результат'],done:'Согласовано'});
    assert.equal((await crm(editor,'PUT','/deals/criteria?companyCode=alvi',{stages:rows})).status,403);
    const saved=await crm(owner,'PUT','/deals/criteria?companyCode=alvi',{stages:rows});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.stages[0].color,'#44aa99');assert.equal(saved.body.stages[0].label,'Новый запрос');
    const custom=saved.body.stages.at(-1),fresh=result.body;
    assert.equal((await crm(editor,'PATCH',secondPath,{version:fresh.version,stage:custom.code})).status,409);
    result=await crm(editor,'PATCH',secondPath,{version:fresh.version,stage:custom.code,data:{checks:{[custom.criteria[0].id]:true}}});assert.equal(result.status,200,JSON.stringify(result.body));
    const remove=saved.body.stages.filter(s=>s.code!==custom.code).map(s=>({...rows.find(r=>r.code===s.code),code:s.code}));
    assert.equal((await crm(owner,'PUT','/deals/criteria?companyCode=alvi',{stages:remove})).status,409);
  });
  assertNoQueuedOrAttemptedEmail();
});
