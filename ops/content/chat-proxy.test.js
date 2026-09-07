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

test('chat proxy returns 403 for an owner POST without a CSRF token', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-chat-proxy-'));
  const password = 'QA chat proxy password';
  const databasePath = path.join(directory, 'content.sqlite');

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: databasePath, API_KEY: '',
      AUTH_USERS: `owner:owner:${hashPassword(password)}`,
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
    body: JSON.stringify({ login: 'owner', password }),
  });
  assert.equal(login.status, 200);
  const response = await fetch(`${base}/content/hugh/conversations`, {
    method: 'POST',
    headers: {
      cookie: login.headers.get('set-cookie').split(';')[0],
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'test' }),
  });
  assert.equal(response.status, 403);
});

test('chat proxy does not forward origin or referer headers upstream', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-chat-proxy-'));
  const password = 'QA chat proxy password';
  const databasePath = path.join(directory, 'content.sqlite');
  const upstreamPort = await freePort();
  let upstreamHeaders;
  const upstream = require('node:http').createServer((request, response) => {
    upstreamHeaders = request.headers;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await once(upstream, 'listening');

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: databasePath, API_KEY: '',
      AUTH_USERS: `owner:owner:${hashPassword(password)}`,
      SEED_DIR: directory, ASSETS_DIR: path.join(directory, 'assets'),
      SESSION_SECRET: randomBytes(32).toString('hex'), CHAT_API_KEY: randomBytes(24).toString('hex'),
      CHAT_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
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
    body: JSON.stringify({ login: 'owner', password }),
  });
  assert.equal(login.status, 200);
  const response = await fetch(`${base}/content/hugh/conversations`, {
    headers: {
      cookie: login.headers.get('set-cookie').split(';')[0],
      origin: 'https://cabinet.example',
      referer: 'https://cabinet.example/chat',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamHeaders.origin, undefined);
  assert.equal(upstreamHeaders.referer, undefined);
});
