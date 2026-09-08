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
const { hashPassword } = require('./passwords');

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('trademarks document allows owner read/write and rejects a client with 403', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-trademarks-'));
  const password = 'QA trademarks password';
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(directory, 'content.sqlite'),
      API_KEY: '',
      AUTH_USERS: `owner:owner:${hashPassword(password)};client:editor:${hashPassword(password)}`,
      SEED_DIR: path.join(__dirname, 'seed'),
      ASSETS_DIR: path.join(directory, 'assets'),
      SESSION_SECRET: randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Service failed: ${errors}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {
      if (attempt === 99) throw new Error(`Service did not start: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function login(login) {
    const response = await fetch(`${base}/content/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const identity = await fetch(`${base}/content/whoami`, { headers: { cookie } });
    assert.equal(identity.status, 200);
    return { cookie, csrf: (await identity.json()).csrfToken };
  }
  const owner = await login('owner');
  const client = await login('client');
  const url = `${base}/content/synapse-business/trademarks`;
  const read = (session) => fetch(url, { headers: { cookie: session.cookie } });
  const write = (session, markdown) => fetch(url, {
    method: 'PUT',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ markdown }),
  });

  assert.equal((await read(client)).status, 403);
  assert.equal((await write(client, '# Запрещено')).status, 403);
  const initial = await read(owner);
  assert.equal(initial.status, 200);
  assert.match((await initial.json()).markdown, /Что мы умеем предложить клиенту/);
  assert.equal((await write(owner, '# Проверка')).status, 200);
  const saved = await read(owner);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).markdown, '# Проверка');
});
