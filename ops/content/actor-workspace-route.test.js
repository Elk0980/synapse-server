'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { hashPassword } = require('./passwords');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('реальный маршрут хранит личный вопрос без ответа, не раскрывая его другим участникам',
  { timeout: 60000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-workspace-route-'));
    const dbPath = path.join(directory, 'content.sqlite');
    const password = 'Test-actor-workspace-password';
    let child, runtimeServer, crmServer;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(); await exited;
      }
      if (runtimeServer) await new Promise((resolve) => runtimeServer.close(resolve));
      if (crmServer) await new Promise((resolve) => crmServer.close(resolve));
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(directory, { recursive: true, force: true });
    });
    const db = new DatabaseSync(dbPath);
    const auth = createAuthStore(db, `owner:owner:${hashPassword(password)}`);
    const owner = auth.getByLogin('owner');
    for (const login of ['vlad', 'lena']) auth.create(owner.id, { login,
      displayName: login, password, companies: ['taisabai'],
      permissions: ['actor-onboarding.self'] }, hashPassword(password));
    auth.create(owner.id, { login: 'manager', displayName: 'manager', password,
      companies: ['taisabai'], permissions: ['actor-onboarding.manage'] }, hashPassword(password));
    db.close();

    const runtimeCalls = [];
    runtimeServer = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        runtimeCalls.push(payload);
        response.setHeader('content-type', 'application/json');
        if (payload.messages.some((item) => item.content.includes('Личная история Влада'))) {
          response.writeHead(503);
          response.end(JSON.stringify({ error: 'Недоступно' }));
        } else {
          response.writeHead(200);
          response.end(JSON.stringify({ text: 'Личный ответ Хью', provider: 'test', model: 'test' }));
        }
      });
    });
    await new Promise((resolve) => runtimeServer.listen(0, '127.0.0.1', resolve));
    const runtimeBase = `http://127.0.0.1:${runtimeServer.address().port}`;
    const crmCalls = [];
    crmServer = http.createServer((request, response) => {
      if (!request.url.startsWith('/social-stats?')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      const identity = JSON.parse(Buffer.from(request.headers['x-synapse-crm-identity'],
        'base64url').toString());
      crmCalls.push({ path: request.url, key: request.headers['x-api-key'], identity });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ companyCode: 'taisabai', from: '2026-09-01',
        to: '2026-09-23', socialAggregate: { views: 345 },
        platforms: { instagram: { configured: true, dataStatus: 'complete',
          accountRef: 'secret-account', totals: { views: 345 } } },
        crm: { client: 'private-client', revenue: 98765 } }));
    });
    await new Promise((resolve) => crmServer.listen(0, '127.0.0.1', resolve));
    const crmBase = `http://127.0.0.1:${crmServer.address().port}`;
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    let errors = '';
    child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          !key.startsWith('HUGH_FALLBACK_'))),
        PORT: String(port), DATABASE_PATH: dbPath, AUTH_USERS: '', API_KEY: '',
        CRM_URL: crmBase, CRM_API_KEY: 'fake-crm-key', SEED_DIR: directory,
        ASSETS_DIR: path.join(directory, 'assets'),
        SESSION_SECRET: randomBytes(32).toString('hex'),
        HUGH_RUNTIME_URL: runtimeBase, CHAT_URL: '', CHAT_API_KEY: 'fake-test-key' },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode !== null) throw Error(`Сервис не поднялся: ${errors}`);
      try { await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).text(); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    async function request(route, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(base + route, { method,
        headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      return { status: response.status, text, body: text ? JSON.parse(text) : null };
    }
    const sessions = {};
    for (const login of ['owner', 'vlad', 'lena', 'manager']) {
      const loginResponse = await fetch(base + '/content/login', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) });
      assert.equal(loginResponse.status, 200, login);
      const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
      const who = await request('/content/whoami', { headers: { cookie } });
      sessions[login] = { cookie, 'x-csrf-token': who.body.csrfToken };
    }
    const as = (login, route, options = {}) => request(route,
      { ...options, headers: { ...sessions[login], ...options.headers } });
    const messages = '/content/actor-workspace/messages?companyCode=taisabai';
    const text = 'Личная история Влада, которой нет в общей комнате';

    assert.equal((await as('vlad', messages)).body.messages.length, 0);
    assert.equal((await request(messages)).status, 401);
    assert.equal((await as('vlad', messages, { method: 'POST',
      headers: { 'x-csrf-token': '' }, body: { text, clientMessageId: 'route-00001' } })).status, 403);
    const sent = await as('vlad', messages, { method: 'POST',
      body: { text, clientMessageId: 'route-00001' } });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.body.message.aiStatus, 'pending');
    assert.equal(sent.body.message.reply, null);
    assert.equal((await as('vlad', messages, { method: 'POST',
      body: { text, clientMessageId: 'route-00001' } })).body.repeated, true);
    assert.equal(runtimeCalls.length, 1, 'повтор не расходует ещё одно обращение');
    const answered = await as('vlad', messages, { method: 'POST',
      body: { text: 'Второй вопрос после сбоя', clientMessageId: 'route-00002' } });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.message.reply, 'Личный ответ Хью');
    assert.equal(answered.body.message.aiStatus, 'done');
    assert.equal(runtimeCalls.length, 2);
    assert.equal(runtimeCalls[1].audience, 'actor-private');
    assert.equal(runtimeCalls[1].companyCode, 'taisabai');
    assert.equal(JSON.stringify(runtimeCalls[1]).includes(text), false,
      'ожидающий вопрос не смешивается с контекстом следующего');
    assert.equal((await as('lena', messages)).body.messages.length, 0);
    assert.equal((await as('owner', messages)).body.messages.length, 0);
    assert.equal((await as('manager', '/content/actor-workspace/summary?companyCode=taisabai'))
      .text.includes(text), false);
    assert.equal((await as('vlad', '/content/project-chat/taisabai/messages')).text.includes(text), false);
    assert.equal((await as('vlad', '/content/actor-workspace/messages?companyCode=alvi')).status, 403);

    const stats = await as('vlad', '/content/actor-workspace/stats?companyCode=taisabai');
    assert.equal(stats.status, 200, stats.text);
    assert.equal(stats.body.socialAggregate.views, 345);
    assert.equal(stats.text.includes('private-client'), false);
    assert.equal(stats.text.includes('secret-account'), false);
    assert.equal(crmCalls.length, 1);
    assert.equal(crmCalls[0].key, 'fake-crm-key');
    assert.deepEqual(crmCalls[0].identity.permissions, ['analytics.view']);
    assert.deepEqual(crmCalls[0].identity.companyCodes, ['taisabai']);
    assert.equal((await as('vlad', '/content/actor-workspace/stats?companyCode=alvi')).status, 403);
    assert.equal(crmCalls.length, 1, 'чужая компания не отправляется в CRM');
  });
