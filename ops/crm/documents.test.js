'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const net = require('node:net');
const path = require('node:path');

const serverFile = path.join(__dirname, 'server.js');
const key = 'documents-test-key';

function identity(userId, companyCodes, permissions = ['crm.view', 'crm.edit']) {
  return Buffer.from(JSON.stringify({ v: 1, userId, userName: `User ${userId}`, permissions, companyCodes }))
    .toString('base64url');
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(base, method, pathname, body, claims) {
  const response = await fetch(`${base}${pathname}`, { method, headers: {
    'X-API-Key': key, 'X-Synapse-CRM-Identity': claims, 'Content-Type': 'application/json'
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('company document registry enforces scope and review rules', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-documents-'));
  const port = await freePort();
  const child = spawn(process.execPath, [serverFile], { env: { ...process.env, PORT: String(port),
    API_KEY: key, DATABASE_PATH: path.join(directory, 'crm.sqlite'), RATE_LIMIT_MAX: '10000' },
    stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/companies`, { headers: { 'X-API-Key': key } })).status) break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  const admin = identity(99, ['alpha', 'beta']);
  const alphaUploader = identity(1, ['alpha']);
  const alphaReviewer = identity(2, ['alpha']);
  const betaUser = identity(3, ['beta']);
  assert.equal((await request(base, 'POST', '/companies', { code: 'alpha', name: 'Alpha' }, admin)).status, 201);
  assert.equal((await request(base, 'POST', '/companies', { code: 'beta', name: 'Beta' }, admin)).status, 201);

  await t.test('another company cannot read or modify documents', async () => {
    assert.equal((await request(base, 'GET', '/companies/1/documents', undefined, betaUser)).status, 403);
    assert.equal((await request(base, 'PUT', '/companies/1/documents/brief', { linkUrl: 'https://example.test' }, betaUser)).status, 403);
  });
  assert.equal((await request(base, 'PUT', '/companies/1/documents/brief',
    { linkUrl: 'https://example.test/brief' }, alphaUploader)).status, 200);
  assert.equal((await request(base, 'POST', '/companies/1/documents/brief/submit', {}, alphaUploader)).status, 200);

  await t.test('uploader cannot accept own document', async () => {
    const result = await request(base, 'POST', '/companies/1/documents/brief/accept', {}, alphaUploader);
    assert.equal(result.status, 403);
    assert.equal(result.body.details.code, 'SELF_REVIEW_FORBIDDEN');
  });
  await t.test('return without reason is rejected', async () => {
    assert.equal((await request(base, 'POST', '/companies/1/documents/brief/return', {}, alphaReviewer)).status, 400);
  });
  await t.test('accepted document exposes reviewer and date', async () => {
    const accepted = await request(base, 'POST', '/companies/1/documents/brief/accept', {}, alphaReviewer);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'accepted');
    assert.equal(accepted.body.reviewedBy, 2);
    assert.equal(accepted.body.reviewedByName, 'User 2');
    assert.ok(!Number.isNaN(Date.parse(accepted.body.reviewedAt)));
    const listed = await request(base, 'GET', '/companies/1/documents', undefined, alphaUploader);
    assert.equal(listed.body.documents.length, 2);
    assert.equal(listed.body.documents.find((item) => item.documentType === 'brief').reviewedBy, 2);
  });
});
