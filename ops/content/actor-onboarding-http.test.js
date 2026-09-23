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
  const presetsRoute = '/content/actor-onboarding/presets?companyCode=taisabai';
  const candidates = await (await request(presetsRoute, directorAuth)).json();
  assert.ok(candidates.participants.some(item => item.actorId === actor.id && item.preset === null));
  assert.equal((await request(presetsRoute, actorAuth)).status, 403);
  const preset = {direction: 'Недвижимость', role: 'Консультант', cameraComfort: 'on_camera'};
  const presetBody = {actorId: actor.id, revision: 0, preset};
  const noPresetCsrf = await fetch(base + presetsRoute, {method: 'PUT',
    headers: {cookie: directorAuth.cookie, 'Content-Type': 'application/json'}, body: JSON.stringify(presetBody)});
  assert.equal(noPresetCsrf.status, 403);
  assert.equal((await request(presetsRoute, directorAuth, 'PUT', presetBody)).status, 200);
  const untouched = await (await request(route, actorAuth)).json();
  assert.equal(untouched.revision, 0);
  assert.equal(untouched.profile.cameraComfort, 'unknown');
  assert.deepEqual(untouched.directorPreset.values, preset);
  const profile = { direction: 'Переезд', role: 'Личный опыт', cameraComfort: 'small_steps',
    voiceComfort: 'short_voice', boundaries: 'Семья вне кадра', suggestions: 'Снимем короткий маршрут' };
  const saved = await request(route, actorAuth, 'PUT', { revision: 0, profile });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  assert.equal((await request(presetsRoute, directorAuth, 'PUT', {...presetBody, revision: 1,
    preset: {...preset, role: 'Новая рабочая роль'}})).status, 200);
  assert.deepEqual((await (await request(route, actorAuth)).json()).profile, profile);
  const summary = await (await request('/content/actor-onboarding/summary?companyCode=taisabai', directorAuth)).json();
  assert.equal(summary.ready, 1);
  assert.equal(JSON.stringify(summary).includes(profile.boundaries), false);
  const socialsRoute = '/content/actor-onboarding/social-links?companyCode=taisabai';
  const reviewRoute = '/content/actor-onboarding/social-links/review?companyCode=taisabai';
  const social = await request(socialsRoute, actorAuth, 'PUT', {
    platform: 'instagram', publicUrl: 'https://instagram.com/actor', revision: 0,
  });
  assert.equal(social.status, 200);
  assert.equal((await social.json()).links[0].status, 'pending');
  assert.equal((await request(reviewRoute, actorAuth)).status, 403);
  const pending = await (await request(reviewRoute, directorAuth)).json();
  assert.equal(pending.links[0].publicUrl, 'https://instagram.com/actor');
  const noCsrf = await fetch(base + reviewRoute, { method: 'PUT',
    headers: { cookie: directorAuth.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorId: actor.id, platform: 'instagram', revision: 1, decision: 'approved' }) });
  assert.equal(noCsrf.status, 403);
  assert.equal((await request(reviewRoute, directorAuth, 'PUT', {
    actorId: actor.id, platform: 'instagram', revision: 1, decision: 'approved',
  })).status, 200);
  assert.equal((await (await request(socialsRoute, actorAuth)).json()).links[0].status, 'approved');
  assert.equal((await request('/content/actor-onboarding?companyCode=alvi', actorAuth)).status, 403);
  const revoked = await request(`/content/admin/accounts/${actor.id}`, owner, 'PATCH', {
    displayName: 'actor', role: 'editor', companies: ['taisabai'], permissions: [],
  });
  assert.equal(revoked.status, 200);
  assert.equal((await request(route, actorAuth)).status, 403, 'старая cookie не сохраняет отозванное право');
  assert.equal((await request(socialsRoute, actorAuth)).status, 403);
  assert.equal((await (await request(reviewRoute, directorAuth)).json()).links.length, 0);
  assert.ok(!(await (await request(presetsRoute, directorAuth)).json()).participants.some(item => item.actorId === actor.id));
  assert.equal((await request(presetsRoute, directorAuth, 'PUT', {...presetBody, revision: 2})).status, 404);
});
