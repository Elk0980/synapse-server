'use strict';

/* Живой сервис content: вход переживает перезапуск, но не переживает отзыв доступа.
   Проверяется вся сборка — файл ключа, подпись куки, версия сессии и CSRF.
   node --test ops/content/session-persistence.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { hashPassword } = require('./passwords');
const { SECRET_FILE } = require('./session-secret');

const POSIX = process.platform !== 'win32';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function baseEnv(dir, ownerHash) {
  const env = { ...process.env,
    DATABASE_PATH: path.join(dir, 'db.sqlite'), ASSETS_DIR: path.join(dir, 'assets'),
    SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '', CHAT_API_KEY: '',
    AUTH_USERS: `owner:owner:${ownerHash}` };
  // Проверяем именно запуск без переменной окружения.
  delete env.SESSION_SECRET;
  return env;
}

async function startServer(env, stderr = 'ignore') {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', stderr] });
  return { child, port, base: `http://127.0.0.1:${port}` };
}

async function waitHealthy(server) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.child.exitCode !== null) return false;
    try { if ((await fetch(`${server.base}/health`)).ok) return true; } catch { /* сервис ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  // Открытые keep-alive соединения могут задержать штатное завершение.
  const hard = setTimeout(() => server.child.kill('SIGKILL'), 2000);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000).unref())]);
  clearTimeout(hard);
}

const request = (base, url, session, method = 'GET', body) => fetch(base + url, { method,
  headers: { ...(session ? { cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function login(base, name, secret) {
  const response = await fetch(`${base}/content/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: name, password: secret }) });
  assert.equal(response.status, 200, 'вход выполнен');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const profile = await (await request(base, '/content/whoami', { cookie, csrf: '' })).json();
  return { cookie, csrf: profile.csrfToken, profile };
}

test('сессия кабинета переживает перезапуск сервиса и не переживает отзыв', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-persist-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const env = baseEnv(dir, hashPassword(ownerSecret));
  const keyFile = path.join(dir, SECRET_FILE);
  let server = null;
  t.after(async () => {
    await stopServer(server);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ }
  });

  server = await startServer(env);
  assert.ok(await waitHealthy(server), 'первый запуск сервиса');
  const first = await login(server.base, 'owner', ownerSecret);
  assert.equal((await request(server.base, '/content/whoami', first)).status, 200);

  const stored = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(stored, /^[0-9a-f]{64}$/, 'ключ сохранён рядом с базой');
  if (POSIX) assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'ключ читает только владелец процесса');
  assert.equal(fs.existsSync(path.join(dir, 'assets', SECRET_FILE)), false, 'ключ не лежит в каталоге статики');

  await stopServer(server);
  server = await startServer(env);
  assert.ok(await waitHealthy(server), 'второй запуск сервиса');
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), stored, 'перезапуск не пересоздал ключ');
  const restarted = await request(server.base, '/content/whoami', first);
  assert.equal(restarted.status, 200, 'прежняя кука принята после перезапуска');
  const profile = await restarted.json();
  assert.equal(profile.csrfToken, first.csrf, 'CSRF из подписанной куки не изменился');
  assert.equal(profile.userId, first.profile.userId);
  const write = await request(server.base, '/content/project-chat/palitra-love/messages', first, 'POST',
    { text: 'После перезапуска', clientMessageId: 'restart-0001' });
  assert.equal(write.status, 201, 'запись с прежним CSRF работает');

  // Ключ не отдаётся ни одним маршрутом статики.
  for (const route of ['/content/publishing-assets/palitra-love/session-secret.key',
    '/content/alvi/assets/session-secret.key', '/content/alvi/assets/..%2Fsession-secret.key']) {
    assert.notEqual((await fetch(server.base + route)).status, 200, route);
  }

  // Отзыв: смена пароля поднимает версию сессии, прежняя подпись больше не принимается.
  const nextSecret = crypto.randomBytes(24).toString('hex');
  const changed = await request(server.base, `/content/admin/accounts/${profile.userId}/password`, first, 'PUT',
    { password: nextSecret });
  assert.equal(changed.status, 200);
  assert.equal((await request(server.base, '/content/whoami', first)).status, 401, 'отозванная сессия отклонена');
  const second = await login(server.base, 'owner', nextSecret);
  assert.equal((await request(server.base, '/content/whoami', second)).status, 200);

  // Явный ключ из окружения главнее файла и не принимает подписи файлового ключа.
  await stopServer(server);
  const explicit = crypto.randomBytes(32).toString('hex');
  server = await startServer({ ...env, SESSION_SECRET: explicit });
  assert.ok(await waitHealthy(server), 'запуск с явным ключом');
  assert.equal((await request(server.base, '/content/whoami', second)).status, 401,
    'подпись прежним ключом не принимается');
  const third = await login(server.base, 'owner', nextSecret);
  assert.equal((await request(server.base, '/content/whoami', third)).status, 200);

  // Тот же явный ключ — сессия переживает и этот перезапуск, файл не тронут.
  await stopServer(server);
  server = await startServer({ ...env, SESSION_SECRET: explicit });
  assert.ok(await waitHealthy(server), 'повторный запуск с тем же явным ключом');
  assert.equal((await request(server.base, '/content/whoami', third)).status, 200);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), stored, 'при заданной переменной файл не переписывается');
});

test('повреждённый файл ключа останавливает запуск сервиса', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-broken-'));
  const env = baseEnv(dir, hashPassword(crypto.randomBytes(24).toString('hex')));
  fs.writeFileSync(path.join(dir, SECRET_FILE), 'повреждённый ключ', { mode: 0o600 });
  let server = null;
  t.after(async () => {
    await stopServer(server);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ }
  });

  server = await startServer(env, 'pipe');
  let stderr = '';
  server.child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const outcome = await Promise.race([once(server.child, 'exit'),
    new Promise((resolve) => setTimeout(() => resolve(null), 10000).unref())]);
  assert.ok(outcome, 'сервис завершается, а не работает с непригодным ключом');
  const [code] = outcome;
  assert.notEqual(code, 0, 'сервис не поднимается с непригодным ключом');
  assert.match(stderr, /Ключ подписи сессий/);
  assert.match(stderr, /повреждён/);
  assert.equal(fs.readFileSync(path.join(dir, SECRET_FILE), 'utf8'), 'повреждённый ключ', 'ключ не перезаписан');
});
