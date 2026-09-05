'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
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

async function request(base, method, pathname, body, session) {
  const headers = session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {};
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
    for (const [login, permissions] of [
      ['editor', ['crm.view', 'crm.edit']], ['viewer', ['analytics.view']],
    ]) {
      const user = auth.create(owner.id, { login, displayName: login, password }, hashPassword(password));
      auth.updateAccess(owner.id, user.id, ['alvi'], permissions);
    }
  } finally { db.close(); }

  const apiKey = randomBytes(24).toString('hex');
  async function start(file, env, healthPath) {
    const port = await freePort();
    const child = spawn(process.execPath, [file], {
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
  const crmBase = await start(path.join(__dirname, '../crm/server.js'), {
    DATABASE_PATH: path.join(directory, 'crm.sqlite'), API_KEY: apiKey, RATE_LIMIT_MAX: '10000',
  }, '/contacts');
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
  const viewer = await login('viewer');
  const crm = (session, method, pathname, body) =>
    request(base, method, `/content/crm${pathname}`, body, session);
  const other = await crm(owner, 'POST', '/companies', { code: 'avokado', name: 'QA Other' });
  const own = await crm(owner, 'POST', '/companies', { code: 'alvi', name: 'QA ALVI', pipelineStage: 'new' });
  assert.equal(other.status, 201);
  assert.equal(own.status, 201);
  assert.equal(own.body.id, 2);
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
  await t.test('editor can edit ordinary company data and create/delete scoped contacts', async () => {
    const changed = await crm(editor, 'PATCH', `${ownPath}?companyCode=alvi`, { name: 'QA Updated' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.name, 'QA Updated');
    assert.equal((await crm(editor, 'PATCH', `/companies/${other.body.id}?companyCode=alvi`,
      { name: 'Forbidden' })).status, 404);
    const contact = await crm(editor, 'POST', '/contacts?companyCode=alvi', { name: 'QA Scoped' });
    assert.equal(contact.status, 201);
    assert.equal((await crm(editor, 'GET', `/contacts/${contact.body.id}?companyCode=alvi`)).status, 200);
    assert.equal((await crm(editor, 'DELETE', `/contacts/${contact.body.id}?companyCode=alvi`)).status, 200);
    assert.equal((await crm(editor, 'GET', `/contacts/${contact.body.id}?companyCode=alvi`)).status, 404);
  });
});
