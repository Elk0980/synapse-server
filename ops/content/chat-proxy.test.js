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

test('chat proxy returns 403 for a non-owner', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-chat-proxy-'));
  const password = 'QA chat proxy password';
  const databasePath = path.join(directory, 'content.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    const auth = createAuthStore(db, `owner:owner:${hashPassword(password)}`);
    const owner = auth.getByLogin('owner');
    auth.create(owner.id, { login: 'editor', displayName: 'Editor', password }, hashPassword(password));
  } finally { db.close(); }

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: databasePath, API_KEY: '', AUTH_USERS: '',
      SEED_DIR: directory, ASSETS_DIR: path.join(directory, 'assets'),
      SESSION_SECRET: randomBytes(32).toString('hex'), CHAT_API_KEY: randomBytes(24).toString('hex'),
    },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
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
      await response.text();
      break;
    } catch {
      if (attempt === 99) throw new Error(`Service did not start: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const login = await fetch(`${base}/content/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'editor', password }),
  });
  assert.equal(login.status, 200);
  const response = await fetch(`${base}/content/hugh/conversations`, {
    headers: { cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(response.status, 403);
});
