'use strict';
/* Контент → Подключения через настоящие сервисы контента и CRM: сессия, права autoposting.view ИЛИ
   analytics.view своей компании, отказ чужой компании и crm.view, только GET. Данные синтетические. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { randomBytes } = require('node:crypto'), { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store'), { hashPassword } = require('./passwords');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('подключения через прокси: права, изоляция компании, только чтение', { timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-connections-proxy-')), children = [];
  t.after(async () => {
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const contentDb = path.join(directory, 'content.sqlite'), crmDb = path.join(directory, 'crm.sqlite');
  const password = 'Local-connections-password', key = randomBytes(32).toString('hex');
  const authDb = new DatabaseSync(contentDb);
  const auth = createAuthStore(authDb, `owner:owner:${hashPassword(password)}`), owner = auth.getByLogin('owner');
  for (const [login, companies, permissions] of [['poster', ['avokado'], ['autoposting.view']], ['analyst', ['avokado'], ['analytics.view']],
    ['stranger', ['alvi'], ['autoposting.view', 'analytics.view']], ['crmonly', ['avokado'], ['crm.view']]]) {
    auth.create(owner.id, { login, displayName: login, password, companies, permissions }, hashPassword(password));
  }
  authDb.close();

  const crmPort = await freePort(), contentPort = await freePort();
  const crmBase = `http://127.0.0.1:${crmPort}`, contentBase = `http://127.0.0.1:${contentPort}`;
  async function start(file, env, base) {
    let errors = '';
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child); child.stderr.on('data', (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw Error('Service failed: ' + errors);
      try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(500) }); await r.text(); return; }
      catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    throw Error('Service not ready: ' + errors);
  }
  await start(path.join(__dirname, '../crm/server.js'), { PORT: String(crmPort), DATABASE_PATH: crmDb, API_KEY: key, RATE_LIMIT_MAX: '10000',
    STRICT_ORIGIN: '', LEADS_SMTP_HOST: '', LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '', LEADS_NOTIFY_EMAIL: '',
    CONTENT_CONNECTIONS_DECLARED: '{"avokado":{"metrika":{"by":"Владелец","date":"2026-11-04"}}}' }, crmBase);
  await start(path.join(__dirname, 'server.js'), { PORT: String(contentPort), DATABASE_PATH: contentDb, AUTH_USERS: '', API_KEY: '',
    CRM_URL: crmBase, CRM_API_KEY: key, SEED_DIR: directory, ASSETS_DIR: path.join(directory, 'assets'),
    SESSION_SECRET: randomBytes(32).toString('hex'), HUGH_RUNNER_URL: '', CHAT_URL: '', CHAT_API_KEY: '', CONTENT_PLAN_WORKER_ENABLED: '0' }, contentBase);

  async function request(base, route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  const forged = Buffer.from(JSON.stringify({ v: 1, userId: 1, role: 'owner', permissions: [], companyCodes: ['alvi', 'avokado'] })).toString('base64url');
  for (const [code, socials] of [['avokado', [{ type: 'vk', url: 'https://vk.com/demo_avokado' }]], ['alvi', []]]) {
    const made = await request(crmBase, '/companies', { method: 'POST', headers: { 'x-api-key': key, 'x-synapse-crm-identity': forged },
      body: { code, name: 'Local ' + code, timezone: 'UTC', websiteUrl: `https://${code}.example/`, socials } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  }
  const sessions = {};
  for (const login of ['owner', 'poster', 'analyst', 'stranger', 'crmonly']) {
    const signed = await request(contentBase, '/content/login', { method: 'POST', body: { login, password } });
    assert.equal(signed.status, 200, login);
    const cookie = signed.headers.get('set-cookie').split(';')[0];
    const profile = await request(contentBase, '/content/whoami', { headers: { cookie } });
    sessions[login] = { cookie, 'x-csrf-token': profile.body.csrfToken };
  }
  const through = (who, route, options = {}) => request(contentBase, '/content/crm/content-connections' + route, { ...options, headers: { ...sessions[who], ...options.headers } });

  assert.equal((await request(contentBase, '/content/crm/content-connections?companyCode=avokado')).status, 401);
  assert.equal((await through('owner', '')).status, 400);
  assert.equal((await through('crmonly', '?companyCode=avokado')).status, 403);
  assert.equal((await through('stranger', '?companyCode=avokado')).status, 403);
  assert.equal((await through('poster', '?companyCode=alvi')).status, 403);
  assert.equal((await through('poster', '?companyCode=avokado', { method: 'POST', body: {} })).status, 405);
  for (const who of ['poster', 'analyst', 'owner']) {
    const read = await through(who, '?companyCode=avokado');
    assert.equal(read.status, 200, who + ' ' + JSON.stringify(read.body));
    assert.equal(read.body.companyCode, 'avokado');
    assert.match(read.headers.get('cache-control'), /no-store/);
    const byId = Object.fromEntries(read.body.platforms.map((p) => [p.id, p]));
    assert.equal(byId.vk.link, 'https://vk.com/demo_avokado'); assert.equal(byId.vk.status, 'red');
    assert.equal(byId.website.link, 'https://avokado.example/'); assert.equal(byId.metrika.status, 'yellow');
  }
  const alvi = await through('stranger', '?companyCode=alvi');
  assert.equal(alvi.status, 200);
  const alviById = Object.fromEntries(alvi.body.platforms.map((p) => [p.id, p]));
  assert.equal(alviById.vk.link, null, 'ссылки Авокадо не видны в АЛВИ');
  assert.equal(alviById.metrika.status, 'red', 'подтверждение владельца Авокадо не переносится на АЛВИ');
  // Прямой запрос в CRM с чужой компанией — отказ на стороне CRM.
  const narrow = Buffer.from(JSON.stringify({ v: 1, userId: 9, role: 'editor', permissions: ['autoposting.view'], companyCodes: ['alvi'] })).toString('base64url');
  assert.equal((await request(crmBase, '/content-connections?companyCode=avokado', { headers: { 'x-api-key': key, 'x-synapse-crm-identity': narrow } })).status, 403);
});
