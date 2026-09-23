'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { hashPassword } = require('./passwords');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('живой кабинет: личный опрос, отдельная сводка и немедленный отзыв доступа', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-onboarding-http-'));
  const port = await freePort();
  const secret = 'Owner-test-password-2026';
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'content.sqlite'),
      ASSETS_DIR: path.join(dir, 'assets'), SEED_DIR: path.join(__dirname, 'seed'),
      API_KEY: '', AUTH_USERS: `owner:owner:${hashPassword(secret)}`,
      SESSION_SECRET: 'actor-onboarding-http-test-secret-2026' }, stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (route, auth, method = 'GET', body) => fetch(base + route, { method,
    headers: { ...(auth ? { cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let healthy = false;
  for (let attempt = 0; attempt < 120 && !healthy; attempt++) {
    try { healthy = (await request('/health')).ok; } catch { /* ожидание запуска */ }
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(healthy, 'сервис должен запуститься');
  const login = async (name, password) => {
    const result = await request('/content/login', null, 'POST', { login: name, password });
    assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie').split(';')[0];
    const profile = await (await request('/content/whoami', { cookie })).json();
    return { cookie, csrf: profile.csrfToken };
  };
  const owner = await login('owner', secret);
  const create = async (login, companies, permissions) => {
    const result = await request('/content/admin/accounts', owner, 'POST', {
      login, displayName: login, password: `${login}-password-2026`, companies, permissions,
    });
    assert.equal(result.status, 201);
    return result.json();
  };
  const actor = await create('actor', ['taisabai'], ['actor-onboarding.self']);
  await create('director', ['taisabai'], ['actor-onboarding.manage']);
  const actorAuth = await login('actor', 'actor-password-2026');
  const directorAuth = await login('director', 'director-password-2026');
  const route = '/content/actor-onboarding?companyCode=taisabai';
  assert.equal((await request(route, actorAuth)).status, 200);
  assert.equal((await request('/content/actor-onboarding/summary?companyCode=taisabai', actorAuth)).status, 403);
  const profile = { direction: 'Переезд', role: 'Личный опыт', cameraComfort: 'small_steps',
    voiceComfort: 'short_voice', boundaries: 'Семья вне кадра', suggestions: 'Снимем короткий маршрут' };
  const saved = await request(route, actorAuth, 'PUT', { revision: 0, profile });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  const summary = await (await request('/content/actor-onboarding/summary?companyCode=taisabai', directorAuth)).json();
  assert.equal(summary.ready, 1);
  assert.equal(JSON.stringify(summary).includes(profile.boundaries), false);
  assert.equal((await request('/content/actor-onboarding?companyCode=alvi', actorAuth)).status, 403);
  const revoked = await request(`/content/admin/accounts/${actor.id}`, owner, 'PATCH', {
    displayName: 'actor', role: 'editor', companies: ['taisabai'], permissions: [],
  });
  assert.equal(revoked.status, 200);
  assert.equal((await request(route, actorAuth)).status, 403, 'старая cookie не сохраняет отозванное право');
});
