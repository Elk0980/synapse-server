'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createCompanyLinksReader, publicLinks } = require('./company-links-reader');
const { hashPassword } = require('./passwords');

const companies = { alvi: 'alvi', avokado3: 'avokado', palitra: 'palitra-love' };
const code = 'avokado';
const allowed = ['website', 'two_gis', 'yandex_maps', 'max', 'telegram', 'telegram_channel', 'whatsapp', 'vk', 'booking'];
const statusIs = status => error => error.status === status;

test('public DTO keeps only allowed links and refuses a different company', () => {
  const links = Object.fromEntries(allowed.map(key => [key, `https://example.test/${key}`]));
  const payload = { companyCode: code, links: { ...links, notes: 'Private notes',
    internal: 'https://private.example.test', phone: '+70000000000' },
    notes: 'Private company notes', socials: [{ type: 'other', url: 'https://private.example.test' }], email: 'private@example.test' };
  assert.deepEqual(publicLinks(payload, code), { companyCode: code, links });
  for (const value of [null, {}, { companyCode: 'alvi', links }, { companyCode: code, links: [] },
    { companyCode: code, links: 'invalid' }]) assert.throws(() => publicLinks(value, code), statusIs(502));
});

test('public DTO rejects unsafe URLs including credentials and embedded control characters', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///private', '/relative',
    '//example.test', 'https://user:secret@example.test', 'https://user@example.test',
    'https://exa\nmple.test', 'https://example.test/\u0000', `https://example.test/${'a'.repeat(2000)}`,
    {}, null, 5]) {
    assert.deepEqual(publicLinks({ companyCode: code, links: { max: value } }, code), { companyCode: code, links: {} });
  }
  assert.deepEqual(publicLinks({ companyCode: code, links: { telegram: ' https://t.me/+79501001059 ' } }, code),
    { companyCode: code, links: { telegram: 'https://t.me/+79501001059' } });
});

test('reader maps a known site to its fixed company, sends only internal headers, and forbids redirects', async () => {
  const calls = [];
  const reader = createCompanyLinksReader({ crmUrl: 'http://127.0.0.1:9000', apiKey: 'fixture-internal-key', companies,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, ok: true, text: async () => JSON.stringify({ companyCode: code, links: { max: 'https://max.ru/u/verified' } }) };
    } });
  assert.deepEqual(await reader('avokado3'), { companyCode: code, links: { max: 'https://max.ru/u/verified' } });
  assert.equal(calls[0].url, 'http://127.0.0.1:9000/company-links/avokado');
  assert.deepEqual(calls[0].options.headers, { 'x-api-key': 'fixture-internal-key', accept: 'application/json' });
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  for (const site of ['unknown', '__proto__', 'constructor', 'avokado3?company=alvi']) {
    await assert.rejects(reader(site), statusIs(404));
  }
  assert.equal(calls.length, 1, 'unknown sites must not reach the upstream service');
  const missingKey = createCompanyLinksReader({ crmUrl: 'http://127.0.0.1:9000', apiKey: '', companies,
    fetch: async () => { throw new Error('must not fetch without an internal key'); } });
  await assert.rejects(missingKey('alvi'), statusIs(503));
});

test('upstream failure, malformed data and a mismatched company produce safe bounded errors', async () => {
  for (const [response, expected] of [
    [{ status: 404, ok: false }, 404],
    [{ status: 401, ok: false }, 502],
    [{ status: 500, ok: false }, 502],
    [{ status: 200, ok: true, text: async () => 'not JSON' }, 502],
    [{ status: 200, ok: true, text: async () => 'x'.repeat(32001) }, 502],
    [{ status: 200, ok: true, text: async () => JSON.stringify({ companyCode: 'alvi', links: {} }) }, 502],
    [{ status: 200, ok: true, text: async () => { throw new Error('private upstream body error'); } }, 502],
  ]) {
    const reader = createCompanyLinksReader({ crmUrl: 'http://127.0.0.1:9000', apiKey: 'fixture-key', companies,
      fetch: async () => response });
    await assert.rejects(reader('avokado3'), error => error.status === expected && !error.message.includes('private'));
  }
  const reader = createCompanyLinksReader({ crmUrl: 'http://127.0.0.1:9000', apiKey: 'fixture-key', companies,
    fetch: async () => { throw new Error('private upstream connection details'); } });
  await assert.rejects(reader('avokado3'), error => error.status === 503 && !error.message.includes('private'));
});

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'content-company-links-'));
  const apiKey = randomBytes(24).toString('hex');
  const calls = [];
  let handler = (request, response) => {
    const companyCode = request.url.slice('/company-links/'.length);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ companyCode, links: { max: `https://max.ru/u/${companyCode}` } }));
  };
  const upstream = http.createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    handler(request, response);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(directory, 'content.sqlite'),
      ASSETS_DIR: path.join(directory, 'assets'), SEED_DIR: directory, API_KEY: '',
      AUTH_USERS: `owner:owner:${hashPassword(randomBytes(24).toString('hex'))}`,
      SESSION_SECRET: randomBytes(32).toString('hex'), CRM_URL: upstreamUrl, CRM_API_KEY: apiKey },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Content service failed: ${errors}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      await response.text();
      if (response.ok) break;
    } catch {}
    if (attempt === 99) throw new Error('Content service did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const request = async (pathname, options = {}) => {
    const response = await fetch(base + pathname, { ...options, signal: AbortSignal.timeout(8000) });
    const body = await response.text();
    return { status: response.status, body: body ? JSON.parse(body) : null, headers: response.headers };
  };
  return { request, apiKey, calls, upstreamUrl, respondWith: next => { handler = next; } };
}

test('real content route fixes the site company and never forwards browser cookies, keys or identity', async t => {
  const f = await fixture(t);
  f.respondWith((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ companyCode: 'avokado', notes: 'Private note',
      links: { max: 'https://max.ru/u/verified', telegram: 'https://t.me/+79501001059',
        booking: 'javascript:alert(1)', internal: 'https://private.example.test', email: 'private@example.test' } }));
  });
  const result = await f.request('/public-company-links/avokado3?company=alvi&companyCode=alvi&site=alvi', {
    headers: { Cookie: 'synapse_session=browser-cookie', Authorization: 'Bearer browser-secret',
      'X-API-Key': 'browser-key', 'X-Synapse-CRM-Identity': 'browser-identity', 'X-CSRF-Token': 'browser-csrf' },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { companyCode: 'avokado', links: { max: 'https://max.ru/u/verified', telegram: 'https://t.me/+79501001059' } });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/company-links/avokado');
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].headers['x-api-key'], f.apiKey);
  assert.equal(f.calls[0].headers.accept, 'application/json');
  for (const header of ['cookie', 'authorization', 'x-synapse-crm-identity', 'x-csrf-token']) {
    assert.equal(f.calls[0].headers[header], undefined);
  }
  for (const pathname of ['/public-company-links/unknown', '/public-company-links/__proto__',
    '/public-company-links/avokado3/extra', '/public-company-links']) {
    assert.equal((await f.request(pathname)).status, 404);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal((await f.request('/public-company-links/avokado3', { method })).status, 404);
  }
  assert.equal(f.calls.length, 1, 'invalid routes and methods must not contact CRM');
  for (const [status, body, expected] of [
    [200, { companyCode: 'alvi', links: { max: 'https://max.ru/u/other-company' } }, 502],
    [404, { error: 'Private missing details' }, 404],
    [500, { error: 'Private CRM details' }, 502],
  ]) {
    f.respondWith((request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    const failure = await f.request('/public-company-links/avokado3');
    assert.equal(failure.status, expected);
    assert.ok(!JSON.stringify(failure.body).includes('Private'));
    assert.ok(!JSON.stringify(failure.body).includes('other-company'));
  }
  f.respondWith((request, response) => {
    response.writeHead(302, { location: `${f.upstreamUrl}/redirect-target` });
    response.end();
  });
  const beforeRedirect = f.calls.length;
  assert.equal((await f.request('/public-company-links/avokado3')).status, 503);
  assert.equal(f.calls.length, beforeRedirect + 1, 'redirect must never be followed with the internal key');
});

test('real content route bounds stalled CRM headers and body with the same five-second deadline', async t => {
  const f = await fixture(t);
  f.respondWith((request, response) => {
    if (request.url === '/company-links/avokado') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"companyCode":"avokado","links":');
    }
    // Leave ALVI headers and the Avokado body pending until AbortSignal aborts.
  });
  const started = Date.now();
  const [headers, body] = await Promise.all([
    f.request('/public-company-links/alvi'), f.request('/public-company-links/avokado3'),
  ]);
  assert.equal(headers.status, 503);
  assert.equal(body.status, 502);
  assert.ok(Date.now() - started < 7500, 'headers and body must both finish before the client deadline');
  assert.ok(!JSON.stringify([headers.body, body.body]).includes('companyCode'));
  assert.equal(f.calls.length, 2);
});
