'use strict';

/* Сшивка заявки с визитом по clientId (spec 112). Компании, посетители и даты синтетические. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('заявка без своих меток берёт первое касание того же посетителя этой компании', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-stitch-'));
  const apiKey = randomBytes(24).toString('hex');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, API_KEY: apiKey, DATABASE_PATH: path.join(directory, 'crm.sqlite'),
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
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/companies`, { headers: { 'X-API-Key': apiKey } });
      break;
    } catch {
      if (child.exitCode !== null || attempt > 200) throw new Error(stderr || 'server did not start');
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
  for (const code of ['stitch_a', 'stitch_b']) {
    assert.equal((await request('POST', '/companies', { code, name: code })).status, 201);
  }
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  const visit = (over) => request('POST', '/events', {
    type: 'visit', companyCode: 'stitch_a', page: '/', ...over,
  }, false);
  // Первое касание — 2ГИС, позже тот же посетитель пришёл напрямую: берётся первое.
  assert.equal((await visit({ clientId: 'v-2gis', referrer: 'https://2gis.ru/irkutsk', ts: at(60) })).status, 202);
  assert.equal((await visit({ clientId: 'v-2gis', referrer: '', ts: at(30) })).status, 202);
  assert.equal((await visit({
    clientId: 'v-direct-ad', utmSource: 'yandex-direct', utmMedium: 'cpc', utmCampaign: 'cmp-1', ts: at(20),
  })).status, 202);
  assert.equal((await visit({ clientId: 'v-typed', referrer: '', ts: at(15) })).status, 202);
  assert.equal((await visit({ clientId: 'v-other', companyCode: 'stitch_b', referrer: 'https://vk.ru/a', ts: at(10) }))
    .status, 202);
  assert.equal((await visit({ clientId: 'v-old', referrer: 'https://vk.ru/a', ts: at(31 * 24 * 60) })).status, 202);

  let phone = 0;
  const lead = async (over) => {
    phone += 1;
    const result = await request('POST', '/leads', {
      name: 'Synthetic', contact: `+7000000020${phone}`, companyCode: 'stitch_a', ...over,
    }, false);
    assert.equal(result.status, 201);
    assert.deepEqual(Object.keys(result.body).sort(), ['deduplicated', 'id'], 'публичный ответ без полей визита');
    // Сохранённую заявку читаем доверенным запросом с ключом.
    return (await request('GET', `/leads/${result.body.id}`)).body;
  };
  const fromMap = await lead({ clientId: 'v-2gis' });
  assert.equal(fromMap.source, '2gis');
  assert.equal(fromMap.referrer, 'https://2gis.ru/irkutsk');
  const fromAd = await lead({ clientId: 'v-direct-ad' });
  assert.equal(fromAd.source, 'yandex-direct');
  assert.equal(fromAd.utmMedium, 'cpc');
  assert.equal(fromAd.utmCampaign, 'cmp-1');
  const keepsForm = await lead({ clientId: 'v-direct-ad', utmCampaign: 'form-campaign', utmMedium: 'social' });
  assert.equal(keepsForm.source, 'yandex-direct', 'источник визита заполняет пустое поле');
  assert.equal(keepsForm.utmCampaign, 'form-campaign', 'UTM формы не затираются визитом');
  assert.equal(keepsForm.utmMedium, 'social');
  assert.equal(keepsForm.utmContent, null);
  assert.equal((await lead({ clientId: 'v-typed' })).source, null, 'прямой заход остаётся прямым');
  assert.equal((await lead({ clientId: 'v-2gis', utmSource: 'vk' })).source, 'vk', 'UTM формы важнее визита');
  assert.equal((await lead({ clientId: 'v-2gis', source: 'Сайт' })).source, 'Сайт', 'явный источник не меняется');
  assert.equal((await lead({ clientId: 'v-other' })).source, null, 'визит другой компании не используется');
  assert.equal((await lead({ clientId: 'v-old' })).source, null, 'касание старше 30 дней не используется');
  assert.equal((await lead({ clientId: 'v-unknown' })).source, null);

  const from = at(32 * 24 * 60).slice(0, 10);
  const to = new Date(now + 86400000).toISOString().slice(0, 10);
  const dashboard = await request('GET', `/dashboard?companyCode=stitch_a&from=${from}&to=${to}`);
  const map = dashboard.body.sourceStats.find((row) => row.source === '2gis');
  assert.equal(map.visits, 1);
  assert.equal(map.leads, 1, 'заявка в той же строке, что визит');
  assert.equal(dashboard.body.sourceStats.find((row) => row.source === 'yandex-direct').leads, 2);
});
