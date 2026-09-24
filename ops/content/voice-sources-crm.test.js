'use strict';
/* Реальные сервисы content + CRM: ролик подтверждается CRM, fail closed, приватные файлы не раздаются публично. */
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { once } = require('node:events'), { randomBytes } = require('node:crypto');
const { mkdtemp, rm, readdir } = require('node:fs/promises'), { tmpdir } = require('node:os'), path = require('node:path'), net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store'), { hashPassword } = require('./passwords');
const audio = require('./voice-audio-fixtures');

async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

test('голос: CRM подтверждает ролик компании, сбой CRM — отказ, публичной раздачи нет', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'voice-sources-crm-')), children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await rm(directory, { recursive: true, force: true });
  });
  const password = 'Fixture account password', database = path.join(directory, 'content.sqlite');
  const authDb = new DatabaseSync(database);
  try {
    const auth = createAuthStore(authDb, `owner:owner:${hashPassword(password)}`), owner = auth.getByLogin('owner');
    for (const [login, permissions] of [['editor', ['autoposting.view', 'autoposting.edit']], ['viewer', ['autoposting.view']]]) {
      const user = auth.create(owner.id, { login, displayName: login, password }, hashPassword(password));
      auth.updateAccess(owner.id, user.id, ['alvi'], permissions);
    }
  } finally { authDb.close(); }
  const apiKey = randomBytes(24).toString('hex');
  async function start(file, env) {
    const port = await freePort(), child = spawn(process.execPath, [file], { env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    children.push(child); let errors = ''; child.stderr.on('data', c => errors += c);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw Error('Service failed: ' + errors);
      try { await (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).text(); return base; } catch { await new Promise(r => setTimeout(r, 25)); }
    }
    throw Error('Service did not start');
  }
  const crmBase = await start(path.join(__dirname, '../crm/server.js'), { DATABASE_PATH: path.join(directory, 'crm.sqlite'), API_KEY: apiKey,
    LEADS_SMTP_HOST: '', LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '', LEADS_NOTIFY_EMAIL: '', LEADS_NOTIFY_EMAIL_ALVI: '', LEADS_NOTIFY_EMAIL_AVOKADO: '' });
  for (const code of ['alvi', 'avokado']) {
    const r = await fetch(crmBase + '/companies', { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ code, name: code, timezone: 'UTC' }) });
    assert.equal(r.status, 201); await r.text();
  }
  const assetsDir = path.join(directory, 'assets'), common = { DATABASE_PATH: database, API_KEY: '', AUTH_USERS: '', SEED_DIR: directory, ASSETS_DIR: assetsDir,
    SESSION_SECRET: randomBytes(32).toString('hex'), CRM_API_KEY: apiKey };
  const base = await start(path.join(__dirname, 'server.js'), { ...common, CRM_URL: crmBase });

  async function call(root, method, pathname, { session, body, type } = {}) {
    const headers = { ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(type ? { 'content-type': type } : {}) };
    const r = await fetch(root + pathname, { method, headers, body, signal: AbortSignal.timeout(8000) });
    const buffer = Buffer.from(await r.arrayBuffer());
    return { status: r.status, buffer, json: r.headers.get('content-type')?.includes('json') ? JSON.parse(buffer.toString() || 'null') : null, headers: r.headers };
  }
  async function login(root, name) {
    const signed = await call(root, 'POST', '/content/login', { body: JSON.stringify({ login: name, password }), type: 'application/json' });
    assert.equal(signed.status, 200);
    const session = { cookie: signed.headers.get('set-cookie').split(';')[0] };
    session.csrf = (await call(root, 'GET', '/content/whoami', { session })).json.csrfToken;
    return session;
  }
  const owner = await login(base, 'owner'), editor = await login(base, 'editor'), viewer = await login(base, 'viewer');
  const createPost = async code => {
    const r = await call(base, 'POST', `/content/crm/autoposting/posts?companyCode=${code}`, { session: owner, body: JSON.stringify({ title: 'Ролик ' + code }), type: 'application/json' });
    assert.equal(r.status, 201, r.buffer.toString()); return r.json.id;
  };
  const alviPost = await createPost('alvi'), avokadoPost = await createPost('avokado');
  const upload = (session, code, postId, bytes = audio.m4a(), type = 'audio/x-m4a', root = base) =>
    call(root, 'POST', `/content/voice-sources?companyCode=${code}&postId=${postId}&name=voice.m4a`, { session, body: bytes, type });

  const created = await upload(editor, 'alvi', alviPost);
  assert.equal(created.status, 201, created.buffer.toString());
  const item = created.json.item;
  assert.equal((await upload(owner, 'alvi', avokadoPost)).status, 404, 'чужой ролик под своей компанией');
  assert.equal((await upload(owner, 'alvi', 999999)).status, 404, 'несуществующий ролик');
  assert.equal((await upload(editor, 'avokado', avokadoPost)).status, 403);
  assert.equal((await upload(viewer, 'alvi', alviPost)).status, 403);
  assert.equal((await upload(editor, 'alvi', alviPost, audio.m4a({ tracks: [['soun', 'mp4a'], ['vide', 'avc1']] }), 'audio/mp4')).status, 415);
  assert.equal((await upload(editor, 'alvi', alviPost, audio.ogg({ audio: false }), 'audio/ogg')).status, 415);
  assert.equal((await call(base, 'GET', `/content/voice-sources?companyCode=alvi&postId=${avokadoPost}`, { session: owner })).status, 404);
  const listed = await call(base, 'GET', `/content/voice-sources?companyCode=alvi&postId=${alviPost}`, { session: viewer });
  assert.deepEqual(listed.json.items.map(i => i.id), [item.id]);
  const played = await call(base, 'GET', item.url, { session: viewer });
  assert.equal(played.status, 200); assert.ok(played.buffer.equals(audio.m4a()));

  // Публичной раздачи нет: ни без сессии, ни через маршруты сайтов и публичных материалов.
  const [diskName] = await readdir(path.join(assetsDir, 'voice-sources', 'alvi'));
  for (const probe of [item.url, `/content/voice-sources/assets/${diskName}`, `/content/voice-sources/alvi/${diskName}`, `/content/publishing-assets/alvi/${diskName}`,
    `/content/alvi/assets/..%2Fvoice-sources%2Falvi%2F${diskName}`, `/content/voice%2Dsources/assets/${diskName}`, `/content/voice-sources/assets/alvi`, `/voice-sources/alvi/${diskName}`, `/data/assets/voice-sources/alvi/${diskName}`]) {
    const r = await call(base, 'GET', probe);
    assert.ok([401, 404].includes(r.status), `${probe} → ${r.status}`);
    assert.ok(!r.buffer.includes(audio.m4a().subarray(0, 24)), `${probe} отдал содержимое`);
  }

  // CRM недоступна: content с неверным адресом CRM не принимает и не показывает записи.
  const closedPort = await freePort();
  const isolated = await start(path.join(__dirname, 'server.js'), { ...common, CRM_URL: `http://127.0.0.1:${closedPort}` });
  const offline = await login(isolated, 'editor');
  assert.equal((await upload(offline, 'alvi', alviPost, audio.m4a(), 'audio/x-m4a', isolated)).status, 502);
  assert.equal((await call(isolated, 'GET', `/content/voice-sources?companyCode=alvi&postId=${alviPost}`, { session: offline })).status, 502);
  assert.equal((await readdir(path.join(assetsDir, 'voice-sources', 'alvi'))).length, 1, 'при сбое CRM файл не сохранён');
});
