'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { deriveSource } = require('./server.js');

test('deriveSource normalizes UTM and known referrer hosts', () => {
  const cases = [
    [{ utmSource: '  Yandex ' }, 'yandex'],
    [{ referrer: 'https://2gis.ru/moscow' }, '2gis'],
    [{ referrer: 'https://maps.yandex.ru/' }, 'yandex'],
    [{ referrer: 'https://ya.ru/' }, 'yandex'],
    [{ referrer: 'https://www.google.com/search?q=x' }, 'google'],
    [{ referrer: 'https://instagram.com/a' }, 'instagram'],
    [{ referrer: 'https://vk.ru/a' }, 'vk'],
    [{ referrer: 'https://t.me/a' }, 'telegram'],
    [{ referrer: 'https://telegram.org/a' }, 'telegram'],
    [{ referrer: 'https://web.telegram.org/a' }, 'telegram'],
    [{ referrer: 'https://wa.me/123' }, 'whatsapp'],
    [{ referrer: 'https://api.whatsapp.com/send' }, 'whatsapp'],
    [{ referrer: 'https://www.example.test/a' }, 'example.test'],
    [{ referrer: '' }, 'direct'],
  ];
  for (const [input, expected] of cases) assert.equal(deriveSource(input), expected);
});

test('events, external snapshots, attribution and analytics work together', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-analytics-'));
  const databasePath = path.join(directory, 'crm.sqlite');
  const apiKey = randomBytes(24).toString('hex');
  const port = 30000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, API_KEY: apiKey, DATABASE_PATH: databasePath,
      PORT: String(port), RATE_LIMIT_MAX: '10000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/companies`, {
        headers: { 'X-API-Key': apiKey },
      });
      break;
    } catch {
      if (child.exitCode !== null) throw new Error(stderr);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const request = async (method, pathname, body, authenticated = true) => {
    const headers = authenticated ? { 'X-API-Key': apiKey } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('POST', '/companies', {
    code: 'analytics_co', name: 'Analytics Co',
  })).status, 201);
  const visit = {
    type: 'visit', companyCode: 'analytics_co', clientId: 'visitor-1',
    page: '/contacts', referrer: 'https://2gis.ru/moscow', ts: '2026-09-05T10:00:00Z',
  };
  assert.equal((await request('POST', '/events', visit, false)).status, 202);
  assert.equal((await request('POST', '/events', visit, false)).status, 202);
  assert.equal((await request('POST', '/events', {
    ...visit, type: 'click', target: 'phone', ts: '2026-09-05T10:05:00Z',
  }, false)).status, 202);
  assert.equal((await request('POST', '/events', {
    ...visit, clientId: 'direct-visitor', referrer: '', ts: '2026-09-05T10:10:00Z',
  }, false)).status, 202);
  assert.equal((await request('POST', '/events', {
    ...visit, companyCode: 'missing',
  }, false)).status, 400);
  const stats = {
    source: '2gis', companyCode: 'analytics_co', note: 'daily import',
    rows: [{ date: '2026-09-05', pageViews: 10, calls: 2 }],
  };
  assert.equal((await request('POST', '/external-stats', stats)).body.upserted, 1);
  stats.rows[0].pageViews = 12;
  await request('POST', '/external-stats', stats);
  const external = await request(
    'GET', '/external-stats?source=2gis&companyCode=analytics_co&from=2026-09-05&to=2026-09-05'
  );
  assert.equal(external.body.rows.length, 1);
  assert.equal(external.body.rows[0].metrics.pageViews, 12);
  assert.equal((await request('POST', '/external-stats', {
    source: 'outside', companyCode: 'analytics_co', rows: [{ date: '2026-08-01', views: 1 }],
  })).body.upserted, 1);
  const leadFromReferrer = await request('POST', '/leads', {
    name: 'Referrer Lead', contact: '+70000000001', companyCode: 'analytics_co',
    referrer: 'https://2gis.ru/a',
  }, false);
  assert.equal(leadFromReferrer.body.source, '2gis');
  const leadFromUtm = await request('POST', '/leads', {
    name: 'UTM Lead', contact: '+70000000002', companyCode: 'analytics_co',
    utmSource: 'Yandex',
  }, false);
  assert.equal(leadFromUtm.body.source, 'yandex');
  const directLead = await request('POST', '/leads', {
    name: 'Direct Lead', contact: '+70000000003', companyCode: 'analytics_co',
  }, false);
  assert.equal(directLead.body.source, null);
  const dashboard = await request(
    'GET', '/dashboard?companyCode=analytics_co&from=2026-09-05&to=2026-09-05'
  );
  assert.deepEqual(dashboard.body.sources, ['2gis', 'direct', 'outside', 'yandex']);
  const source = dashboard.body.sourceStats.find((row) => row.source === '2gis');
  assert.equal(source.visits, 1);
  assert.equal(source.clicks, 1);
  assert.equal(source.clicksByTarget.phone, 1);
  assert.deepEqual(source.external, { pageViews: 12, calls: 2 });
  const direct = dashboard.body.sourceStats.find((row) => row.source === 'direct');
  assert.equal(direct.leads, 1);
  assert.equal(direct.visits, 1);
  assert.equal(dashboard.body.sourceStats.filter((row) => row.source === 'direct').length, 1);
  const filtered = await request(
    'GET', '/dashboard?companyCode=analytics_co&source=yandex&from=2026-09-05&to=2026-09-05'
  );
  assert.deepEqual(filtered.body.sources, ['2gis', 'direct', 'outside', 'yandex']);
  assert.deepEqual(filtered.body.sourceStats.map((row) => row.source), ['yandex']);
  const summary = await request(
    'GET', '/summary?companyCode=analytics_co&from=2026-09-05&to=2026-09-05'
  );
  assert.deepEqual(summary.body.sources, ['2gis', 'direct', 'outside', 'yandex']);
  assert.equal(summary.body.sourceStats.find((row) => row.source === 'direct').leads, 1);
  const counts = new DatabaseSync(databasePath);
  assert.equal(counts.prepare('SELECT COUNT(*) count FROM events').get().count, 3);
  assert.equal(counts.prepare('SELECT COUNT(*) count FROM external_stats').get().count, 2);
  counts.close();
});
