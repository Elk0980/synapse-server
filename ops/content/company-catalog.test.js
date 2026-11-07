'use strict';
/* specs/226: каталог компаний — создание, валидация, права, изоляция и прежние 6 компаний.
   Настоящие серверы content и CRM на временных базах; внешняя сеть CRM запрещена. Данные — QA. */
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { once } = require('node:events'), { randomBytes } = require('node:crypto');
const { mkdtemp, rm, writeFile } = require('node:fs/promises'), { existsSync } = require('node:fs');
const { tmpdir } = require('node:os'), path = require('node:path'), net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore, COMPANIES } = require('./auth-store'), { hashPassword } = require('./passwords');
const { SEED, normalizeInput } = require('./company-catalog');

async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'company-catalog-')), children = [];
  t.after(async () => {
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await rm(directory, { recursive: true, force: true });
  });
  const password = 'Fixture account password', database = path.join(directory, 'content.sqlite');
  const authDb = new DatabaseSync(database);
  try {
    const auth = createAuthStore(authDb, `owner:owner:${hashPassword(password)}`), owner = auth.getByLogin('owner');
    for (const [login, permissions, companies] of [
      ['lena', ['companies.create', 'autoposting.view'], ['alvi']],
      ['plain', ['autoposting.view', 'autoposting.edit'], ['alvi']],
      ['other', ['companies.create'], ['avokado']],
    ]) { const user = auth.create(owner.id, { login, displayName: login, password }, hashPassword(password)); auth.updateAccess(owner.id, user.id, companies, permissions); }
  } finally { authDb.close(); }
  const apiKey = randomBytes(24).toString('hex'), marker = path.join(directory, 'unexpected-network.txt'), preload = path.join(directory, 'deny-outbound.cjs');
  await writeFile(preload, `'use strict';
    function blocked(){require('node:fs').appendFileSync(${JSON.stringify(marker)},'outbound attempted\\n');throw Error('Fixture outbound disabled');}
    require('node:net').Socket.prototype.connect=blocked;require('node:tls').connect=blocked;`);
  async function start(file, env, guard) {
    const port = await freePort(), child = spawn(process.execPath, [...(guard ? ['--require', guard] : []), file], { env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] }); children.push(child);
    let errors = ''; child.stderr.on('data', c => errors += c); const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error('Fixture service failed: ' + errors);
      try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(500) }); await r.text(); return { base, child }; } catch { await new Promise(r => setTimeout(r, 25)); }
    } throw Error('Fixture service did not start');
  }
  const crm = await start(path.join(__dirname, '../crm/server.js'), { DATABASE_PATH: path.join(directory, 'crm.sqlite'), API_KEY: apiKey,
    LEADS_SMTP_HOST: '', LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '', LEADS_NOTIFY_EMAIL: '', LEADS_NOTIFY_EMAIL_ALVI: '', LEADS_NOTIFY_EMAIL_AVOKADO: '' }, preload);
  for (const code of ['alvi', 'avokado', 'crm-only']) {
    const r = await fetch(crm.base + '/companies', { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ code, name: code, timezone: 'UTC' }) });
    assert.equal(r.status, 201); await r.text();
  }
  const env = { DATABASE_PATH: database, API_KEY: '', AUTH_USERS: '', SEED_DIR: directory, ASSETS_DIR: path.join(directory, 'assets'),
    SESSION_SECRET: randomBytes(32).toString('hex'), CRM_URL: crm.base, CRM_API_KEY: apiKey };
  let content = await start(path.join(__dirname, 'server.js'), env);
  async function request(method, pathname, body, session, headers = {}) {
    const r = await fetch(content.base + pathname, { method, headers: { ...headers, ...(session ? { cookie: session.cookie, ...(session.csrf !== undefined ? { 'x-csrf-token': session.csrf } : {}) } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
    const text = await r.text(); return { status: r.status, body: text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null, headers: r.headers };
  }
  async function login(name) { const s = await request('POST', '/content/login', { login: name, password }); assert.equal(s.status, 200); const session = { cookie: s.headers.get('set-cookie').split(';')[0] }; session.csrf = (await request('GET', '/content/whoami', undefined, session)).body.csrfToken; return session; }
  async function restart() { const exit = once(content.child, 'exit'); content.child.kill(); await exit; content = await start(path.join(__dirname, 'server.js'), env); }
  return { request, login, restart, database, marker };
}

test('validation: code, name, city, IANA timezone with Asia/Irkutsk default, Content Factory module required', () => {
  assert.deepEqual(normalizeInput({ code: 'new-client', name: '  QA  Клиент ' }),
    { code: 'new-client', name: 'QA Клиент', city: '', timezone: 'Asia/Irkutsk', modules: ['content-factory'] });
  for (const code of ['', 'Upper', 'with space', '-edge', 'edge-', 'кириллица', 'a_b', 'x'.repeat(41), 'admin', 7]) {
    assert.throws(() => normalizeInput({ code, name: 'QA' }), e => e.status === 400, String(code));
  }
  for (const body of [{ code: 'qa', name: '' }, { code: 'qa', name: '<b>' }, { code: 'qa', name: 'QA', timezone: 'Mars/Base' },
    { code: 'qa', name: 'QA', timezone: 'GMT+7' }, { code: 'qa', name: 'QA', modules: [] }, { code: 'qa', name: 'QA', modules: ['crm'] },
    { code: 'qa', name: 'QA', extra: 1 }]) assert.throws(() => normalizeInput(body), e => e.status === 400, JSON.stringify(body));
  assert.equal(normalizeInput({ code: 'qa', name: 'QA', timezone: 'Asia/Bangkok', city: 'Паттайя' }).timezone, 'Asia/Bangkok');
});

test('seed keeps the six existing companies and codes; migration is idempotent and never deletes', () => {
  const db = new DatabaseSync(':memory:');
  const auth = createAuthStore(db, `owner:owner:${hashPassword('Fixture account password')}`);
  assert.deepEqual(Object.keys(COMPANIES), SEED.map(([code]) => code));
  assert.equal(COMPANIES['palitra-love'].name, 'Palitra'); assert.equal(COMPANIES.alvi.contentSiteId, 'alvi');
  const owner = auth.getByLogin('owner');
  auth.createCompany(owner.id, { code: 'qa-new', name: 'QA New' });
  db.prepare("UPDATE workspace_companies SET name='Переименовано владельцем' WHERE code='alvi'").run();
  createAuthStore(db, '');
  assert.equal(COMPANIES.alvi.name, 'Переименовано владельцем', 'сид не перезаписывает сохранённые строки');
  assert.ok(COMPANIES['qa-new']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_companies').get().n, 7);
  db.close();
});

test('HTTP: owner and companies.create holder create companies; creator gets only Content Factory rights; isolation holds', async t => {
  const f = await fixture(t);
  const owner = await f.login('owner'), lena = await f.login('lena'), plain = await f.login('plain'), other = await f.login('other');

  // Existing six companies keep working for the owner list and for scoped modules.
  const ownerList = (await f.request('GET', '/content/companies', undefined, owner)).body;
  assert.deepEqual(ownerList.companies.map(c => c.id), SEED.map(([code]) => code)); assert.equal(ownerList.canCreate, true);
  assert.equal((await f.request('GET', '/content/crm/autoposting/posts?companyCode=alvi', undefined, plain)).status, 200);
  const plainList = (await f.request('GET', '/content/companies', undefined, plain)).body;
  assert.deepEqual(plainList, { companies: [{ id: 'alvi', name: 'Алви', contentSiteId: 'alvi', city: '', timezone: 'Asia/Irkutsk', modules: ['content-factory'] }], canCreate: false });

  // Rights and CSRF.
  assert.equal((await f.request('POST', '/content/companies', { code: 'qa-a', name: 'QA A' })).status, 401);
  assert.equal((await f.request('POST', '/content/companies', { code: 'qa-a', name: 'QA A' }, plain)).status, 403);
  assert.equal((await f.request('POST', '/content/companies', { code: 'qa-a', name: 'QA A' }, { ...lena, csrf: 'wrong' })).status, 403);
  assert.equal((await f.request('POST', '/content/companies', { code: 'Bad Code', name: 'QA' }, lena)).status, 400);
  assert.equal((await f.request('POST', '/content/companies', { code: 'alvi', name: 'Дубль' }, lena)).status, 409);
  const taken = await f.request('POST', '/content/companies', { code: 'crm-only', name: 'Чужая CRM' }, lena);
  assert.equal(taken.status, 409); assert.equal(taken.body.code, 'CRM_CODE_TAKEN');

  // Lena creates a new client.
  const created = await f.request('POST', '/content/companies', { code: 'qa-client', name: 'QA Клиент', city: 'Иркутск' }, lena);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.crm, 'created');
  assert.deepEqual(created.body.company, { id: 'qa-client', name: 'QA Клиент', contentSiteId: null, city: 'Иркутск', timezone: 'Asia/Irkutsk', modules: ['content-factory'] });
  const me = (await f.request('GET', '/content/whoami', undefined, lena)).body;
  assert.deepEqual(me.companies.map(c => c.id), ['alvi', 'qa-client']);
  assert.deepEqual([...me.permissions].sort(), ['analytics.view', 'autoposting.edit', 'autoposting.view', 'companies.create',
    'company-information.view', 'settings.edit', 'settings.view']);
  assert.ok(!me.permissions.includes('autoposting.approve') && !me.permissions.includes('content-plan.approve') && !me.permissions.includes('crm.edit'));

  // Content Factory works for the new code; approve and Onlypult profiles stay closed.
  assert.equal((await f.request('GET', '/content/crm/autoposting/posts?companyCode=qa-client', undefined, lena)).status, 200);
  assert.equal((await f.request('GET', '/content/crm/autoposting/settings?companyCode=qa-client', undefined, lena)).status, 200);
  assert.equal((await f.request('GET', '/content/crm/media-mentor?companyCode=qa-client', undefined, lena)).status, 200);
  const draft = await f.request('POST', '/content/crm/autoposting/posts?companyCode=qa-client', { title: 'QA', text: 'QA draft, never sent', mediaUrls: [], platformIds: [], timezone: 'Asia/Irkutsk' }, lena);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal((await f.request('POST', `/content/crm/autoposting/posts/${draft.body.id}/approve?companyCode=qa-client`, { revision: draft.body.revision }, lena)).status, 403);
  assert.equal((await f.request('PUT', '/content/crm/autoposting/settings/onlypult/profiles?companyCode=qa-client', {}, lena)).status, 403);

  // Isolation: other users and other companies.
  assert.equal((await f.request('GET', '/content/crm/autoposting/posts?companyCode=qa-client', undefined, plain)).status, 403);
  assert.equal((await f.request('GET', '/content/crm/autoposting/posts?companyCode=qa-client', undefined, other)).status, 403);
  assert.equal((await f.request('GET', '/content/crm/autoposting/posts?companyCode=avokado', undefined, lena)).status, 403);
  assert.equal((await f.request('GET', `/content/crm/autoposting/posts/${draft.body.id}?companyCode=alvi`, undefined, owner)).status, 404);
  const otherCreated = await f.request('POST', '/content/companies', { code: 'qa-other', name: 'QA Other', timezone: 'Asia/Bangkok' }, other);
  assert.equal(otherCreated.status, 201);
  assert.equal((await f.request('GET', '/content/crm/autoposting/posts?companyCode=qa-other', undefined, lena)).status, 403);
  assert.deepEqual((await f.request('GET', '/content/companies', undefined, other)).body.companies.map(c => c.id), ['avokado', 'qa-other']);

  // Owner: sees all, may reuse an existing CRM card, gets no grants rows (owner has everything).
  const reused = await f.request('POST', '/content/companies', { code: 'crm-only', name: 'CRM Only' }, owner);
  assert.equal(reused.status, 201); assert.equal(reused.body.crm, 'reused'); assert.deepEqual(reused.body.addedPermissions, []);
  assert.deepEqual((await f.request('GET', '/content/companies', undefined, owner)).body.companies.map(c => c.id).slice(6), ['qa-client', 'qa-other', 'crm-only']);
  // Owner can assign the new company through the existing access editor.
  const options = (await f.request('GET', '/content/admin/accounts/access-options', undefined, owner)).body;
  assert.ok(options.companies.some(c => c.id === 'qa-client')); assert.ok(options.permissions.includes('companies.create'));

  // Survives restart; audit records who and when.
  await f.restart();
  const again = await f.login('lena');
  assert.deepEqual((await f.request('GET', '/content/companies', undefined, again)).body.companies.map(c => c.id), ['alvi', 'qa-client']);
  const db = new DatabaseSync(f.database);
  try {
    const rows = db.prepare("SELECT a.actor_user_id, u.login, a.details_json, a.created_at FROM auth_audit a JOIN auth_users u ON u.id=a.actor_user_id WHERE action='COMPANY_CREATED' ORDER BY a.id").all();
    assert.deepEqual(rows.map(r => [r.login, JSON.parse(r.details_json).company]), [['lena', 'qa-client'], ['other', 'qa-other'], ['owner', 'crm-only']]);
    assert.ok(rows.every(r => Date.parse(r.created_at) > 0));
    assert.deepEqual(JSON.parse(rows[0].details_json).addedPermissions.sort(), ['analytics.view', 'autoposting.edit', 'settings.edit', 'settings.view'], 'company-information.view уже был у Лены как зависимость autoposting.view');
    const row = db.prepare("SELECT origin, created_by FROM workspace_companies WHERE code='qa-client'").get();
    assert.equal(row.origin, 'created');
  } finally { db.close(); }
  assert.equal(existsSync(f.marker), false, 'CRM did not reach external network');
});
