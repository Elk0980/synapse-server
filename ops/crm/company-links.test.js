'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { COMPANY_LINK_TYPES, publicLinkUrl, companyPublicLinks } = require('./company-links');

test('company public links project only typed URLs and distinguish Telegram chat from channel', () => {
  const socials = COMPANY_LINK_TYPES.map(type => ({ type, url: `https://example.test/${type}`, label: 'Private label' }));
  const company = { code: 'ALVI', website_url: 'https://example.test/', socials: JSON.stringify(socials),
    phone: '+70000000000', email: 'private@example.test', notes: 'Private company notes', owner_scope: 'private' };
  const before = structuredClone(company);
  assert.deepEqual(companyPublicLinks(company), { companyCode: 'alvi', links: {
    website: 'https://example.test/', ...Object.fromEntries(socials.map(row => [row.type, row.url])),
  } });
  assert.deepEqual(company, before, 'public reads must not backfill or rewrite owner data');
});

test('unsafe, untyped and unknown rows cannot leak into the public response', () => {
  const data = { code: 'avokado', website_url: 'https://user:secret@example.test/', socials: [
    { type: 'other', url: 'https://private.example.test', label: 'MAX' },
    { url: 'https://t.me/channel' },
    { type: 'telegram', handle: '@not-a-verified-link' },
    { type: '__proto__', url: 'https://example.test/' },
    { type: 'constructor', url: 'https://example.test/' },
    { type: 'max', url: 'javascript:alert(1)' },
    { type: ' MAX ', url: ' https://max.ru/u/verified ' },
    { type: 'max', url: 'https://max.ru/u/later-duplicate' },
    null, 'malformed row', ['malformed row'],
  ] };
  assert.deepEqual(companyPublicLinks(data), { companyCode: 'avokado', links: { max: 'https://max.ru/u/verified' } });
});

test('missing, cleared or malformed legacy socials produce an empty projection without resurrecting defaults', () => {
  for (const socials of [undefined, null, '', '{broken', '{}', 'null', '[]', [], {}, 3]) {
    assert.deepEqual(companyPublicLinks({ code: 'alvi', website_url: null, socials }), { companyCode: 'alvi', links: {} });
  }
});

test('public URLs allow HTTP(S) only and preserve verified addresses exactly', () => {
  for (const url of ['https://t.me/+79501001059', 'http://t.me/avokado_studio38', 'https://2gis.ru/irkutsk/firm/1?m=1']) {
    assert.equal(publicLinkUrl(url), url);
  }
  for (const url of [null, {}, '', 'not a url', '//example.test', '/relative', '#contacts',
    'javascript:alert(1)', 'data:text/html,hello', 'file:///private', 'tel:+7000',
    'https://owner:secret@example.test', 'https://owner@example.test',
    'https://exa\nmple.test', 'https://example.test/\u0000', `https://example.test/${'a'.repeat(2000)}`]) {
    assert.equal(publicLinkUrl(url), null);
  }
});

async function withCrm(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-company-links-'));
  const apiKey = randomBytes(24).toString('hex');
  const port = 40000 + Math.floor(Math.random() * 10000);
  let child = null;
  let stderr = '';
  const request = async (method, pathname, body, key = apiKey) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers: { ...(key ? { 'X-API-Key': key } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    child = null;
  };
  const start = async () => {
    stderr = '';
    child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, API_KEY: apiKey, DATABASE_PATH: path.join(directory, 'crm.sqlite'),
        PORT: String(port), RATE_LIMIT_MAX: '10000' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await request('GET', '/companies')).status === 200) return; } catch {}
      if (child.exitCode !== null) throw new Error(stderr || 'CRM exited during startup');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('CRM startup timed out');
  };
  try {
    await start();
    await callback(request, async () => { await stop(); await start(); });
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
}

test('real company API persists links, keeps the projection private, and respects edits and clears after restart', async () => {
  await withCrm(async (request, restart) => {
    const socials = COMPANY_LINK_TYPES.map(type => ({ type, url: `https://example.test/${type}` }));
    socials.push({ type: 'other', label: 'Internal workspace', url: 'https://private.example.test' });
    const created = await request('POST', '/companies', { code: 'qa_links', name: 'QA Public Links',
      websiteUrl: 'https://example.test', socials, phone: '+70000000000', email: 'private@example.test', notes: 'Private notes' });
    assert.equal(created.status, 201);
    const companyPath = `/companies/${created.body.id}`;
    const publicPath = '/company-links/qa_links';
    for (const key of ['', 'wrong-key']) assert.equal((await request('GET', publicPath, undefined, key)).status, 401);
    const publicResponse = await request('GET', '/company-links/QA_LINKS');
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(publicResponse.body, { companyCode: 'qa_links', links: {
      website: 'https://example.test', ...Object.fromEntries(socials.slice(0, -1).map(row => [row.type, row.url])),
    } });
    assert.deepEqual((await request('GET', companyPath)).body.socials, socials, 'existing private CRUD remains lossless');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await request(method, publicPath, { links: {} })).status, 405);
    }
    assert.equal((await request('GET', '/company-links/missing')).status, 404);
    for (const code of ['x', 'bad%20code', 'one/two', 'a'.repeat(65)]) {
      assert.equal((await request('GET', `/company-links/${code}`)).status, 400);
    }
    assert.equal((await request('PATCH', companyPath, { socials: [{ type: 'max', url: 'javascript:alert(1)' }] })).status, 400);
    assert.deepEqual((await request('GET', companyPath)).body.socials, socials, 'rejected URL must not replace saved rows');
    const changedSocials = socials.map(row => row.type === 'max' ? { ...row, url: 'https://max.ru/u/changed' } : row);
    assert.equal((await request('PATCH', companyPath, { socials: changedSocials })).status, 200);
    assert.equal((await request('GET', publicPath)).body.links.max, 'https://max.ru/u/changed');
    assert.deepEqual((await request('GET', companyPath)).body.socials, changedSocials);
    assert.equal((await request('PATCH', companyPath, { websiteUrl: null, socials: [] })).status, 200);
    await restart();
    assert.deepEqual((await request('GET', publicPath)).body, { companyCode: 'qa_links', links: {} });
    assert.equal((await request('GET', companyPath)).body.notes, 'Private notes');
    assert.equal((await request('DELETE', companyPath)).status, 200);
    assert.equal((await request('GET', publicPath)).status, 404);
    assert.equal((await request('POST', `${companyPath}/restore`)).status, 200);
    assert.deepEqual((await request('GET', publicPath)).body, { companyCode: 'qa_links', links: {} });
    const empty = await request('POST', '/companies', { code: 'qa_empty', name: 'QA Empty Links' });
    assert.equal(empty.status, 201);
    assert.deepEqual((await request('GET', '/company-links/qa_empty')).body, { companyCode: 'qa_empty', links: {} });
  });
});
