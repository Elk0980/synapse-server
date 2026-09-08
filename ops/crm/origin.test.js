'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function runServer(strict, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-origin-'));
  const apiKey = randomBytes(24).toString('hex');
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, API_KEY: apiKey, DATABASE_PATH: path.join(directory, 'crm.sqlite'),
      PORT: String(port), RATE_LIMIT_MAX: '10000', STRICT_ORIGIN: strict ? 'true' : '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const request = async (method, pathname, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { ...(method === 'POST' && pathname === '/companies' ? { 'X-API-Key': apiKey } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await request('GET', '/companies', undefined, { 'X-API-Key': apiKey }); break; } catch {
        if (child.exitCode !== null) throw new Error(stderr);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await request('POST', '/companies', {
      code: 'origin_co', name: 'Origin Co', websiteUrl: 'https://www.example.test/path',
      socials: [{ type: 'vk', url: 'https://vk.com/origin' }],
    });
    await callback(request, () => stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('public origin mismatches are logged and optionally rejected', async () => {
  const event = { type: 'click', companyCode: 'origin_co' };
  await runServer(false, async (request, stderr) => {
    assert.equal((await request('POST', '/events', event, { Origin: 'https://evil.test' })).status, 202);
    assert.equal((await request('POST', '/leads', {
      name: 'Allowed', contact: '+70000000001', companyCode: 'origin_co',
    }, { Referer: 'https://example.test/form' })).status, 201);
    assert.match(stderr(), /public origin mismatch/);
    assert.match(stderr(), /evil\.test/);
  });
  await runServer(true, async (request) => {
    assert.equal((await request('POST', '/events', event, { Origin: 'https://example.test' })).status, 202);
    assert.equal((await request('POST', '/events', event, { Origin: 'https://vk.com' })).status, 202);
    const rejected = await request('POST', '/leads', {
      name: 'Rejected', contact: '+70000000002', companyCode: 'origin_co',
    }, { Origin: 'https://evil.test' });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.details.code, 'ORIGIN_MISMATCH');
  });
});
