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
const { normalizeCrmPath } = require('./crm-proxy-path');

// Нормализация пути прокси /content/crm перед проверкой служебных маршрутов.
test('normalizeCrmPath: обычные пути без изменений, повторные «/» схлопываются', () => {
  for (const [raw, expected] of [
    ['', '/'], ['/', '/'], ['/leads', '/leads'], ['/leads/12', '/leads/12'], ['/tasks/summary', '/tasks/summary'],
    ['/leads/', '/leads/'], ['//leads//12', '/leads/12'], ['/company-information', '/company-information'],
    ['/a%20b', '/a%20b'], ['/leads/%31', '/leads/1'], ['/x:y@z', '/x:y@z'],
  ]) assert.deepEqual(normalizeCrmPath(raw), { ok: true, path: expected }, raw);
});

test('normalizeCrmPath: служебные и ненормализованные пути отклоняются', () => {
  for (const raw of ['/internal/x', '//internal/x', '/INTERNAL/x', '/Internal', '/internal', '///internal//x',
    '/%69nternal/x']) assert.deepEqual(normalizeCrmPath(raw), { ok: false, status: 403 }, raw);
  for (const raw of ['/./internal/x', '/../internal/x', '/%2Finternal/x', '/%2finternal', '/%2E/internal',
    '/%2e%2e/internal', '/leads/%2F..', '/a%5Cb', '/%252Finternal', '/%E0%A4%A', '/a%00b', '/.', '/..',
    '/leads;x', '/internal;x', '/leads/1;x', '/leads%3Bx', '/internal%3bx'])
    assert.equal(normalizeCrmPath(raw).ok, false, raw);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Сырой путь отправляется без нормализации клиентом (fetch убрал бы «/./»).
function rawRequest(port, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('timeout'))); req.end();
  });
}

test('прокси /content/crm: служебные пути закрыты, обычные маршруты кабинета проходят тем же путём', { timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-proxy-path-'));
  const children = [];
  const seen = [];
  const crm = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => crm.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    }
    await new Promise((resolve) => crm.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const contentDb = path.join(directory, 'content.sqlite');
  const password = 'Local-proxy-path-fixture-password';
  const authDb = new DatabaseSync(contentDb);
  createAuthStore(authDb, `owner:owner:${hashPassword(password)}`);
  authDb.close();
  const crmBase = `http://127.0.0.1:${crm.address().port}`;
  const contentPort = await freePort();
  const contentBase = `http://127.0.0.1:${contentPort}`;
  let errors = '';
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(contentPort), DATABASE_PATH: contentDb, AUTH_USERS: '', API_KEY: '',
      CRM_URL: crmBase, CRM_API_KEY: randomBytes(32).toString('hex'), SEED_DIR: directory,
      ASSETS_DIR: path.join(directory, 'assets'), SESSION_SECRET: randomBytes(32).toString('hex'),
      HUGH_RUNNER_URL: '', CHAT_URL: '', CHAT_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  children.push(child);
  child.stderr.on('data', (chunk) => { errors += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    if (child.exitCode !== null) throw Error('content failed: ' + errors);
    try { const r = await fetch(contentBase + '/health', { signal: AbortSignal.timeout(500) }); await r.text(); ready = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.ok(ready, 'content not ready: ' + errors);
  const login = await fetch(contentBase + '/content/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'owner', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const blocked = ['/content/crm//internal/task-dispatch/claim', '/content/crm/./internal/task-dispatch/claim',
    '/content/crm/%2Finternal/task-dispatch/claim', '/content/crm/INTERNAL/task-dispatch/claim',
    '/content/crm/%2e/internal/x', '/content/crm/%2E%2E/internal/x', '/content/crm///internal', '/content/crm/Internal/x',
    '/content/crm/a/%2F/internal', '/content/crm/internal;x', '/content/crm/leads;x', '/content/crm/leads%3Bx?companyCode=avokado'];
  for (const route of blocked) {
    const result = await rawRequest(contentPort, route, { cookie });
    assert.ok([403, 404].includes(result.status), `${route} → ${result.status}`);
  }
  assert.deepEqual(seen, [], 'ни один служебный путь не дошёл до CRM');

  for (const [route, forwarded] of [
    ['/content/crm/leads?companyCode=avokado', '/leads?companyCode=avokado'],
    ['/content/crm/dashboard?companyCode=avokado', '/dashboard?companyCode=avokado'],
    ['/content/crm/tasks/summary?companyCode=avokado', '/tasks/summary?companyCode=avokado'],
    ['/content/crm/company-information?companyCode=avokado', '/company-information?companyCode=avokado'],
    ['/content/crm//leads?companyCode=avokado', '/leads?companyCode=avokado'],
  ]) {
    seen.length = 0;
    const result = await rawRequest(contentPort, route, { cookie });
    assert.equal(result.status, 200, `${route} → ${result.status} ${result.text}`);
    assert.deepEqual(seen, [forwarded], route);
  }
});
