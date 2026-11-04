'use strict';

/* Публичный ответ формы заявки (№97): без API-ключа — только номер и признак дубля.
   Имена, телефоны и метки синтетические. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('публичный POST /leads не отдаёт поля заявки ни при создании, ни при дубле', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-lead-public-'));
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
  assert.equal((await request('POST', '/companies', { code: 'public_co', name: 'Public Co' })).status, 201);
  const lead = {
    name: 'Синтетический Клиент', contact: '+70000000301', companyCode: 'public_co',
    comment: 'личный комментарий', utmSource: 'vk', clientId: 'visitor-301', referrer: 'https://vk.ru/a',
  };
  const created = await request('POST', '/leads', lead, false);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: created.body.id, deduplicated: false });
  assert.ok(Number.isSafeInteger(created.body.id) && created.body.id > 0);

  const repeated = await request('POST', '/leads', { ...lead, name: 'Другой', comment: 'другое' }, false);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body, { id: created.body.id, deduplicated: true },
    'по телефону нельзя прочитать чужую заявку');
  const text = JSON.stringify(repeated.body);
  for (const secret of ['Синтетический', 'личный', 'visitor-301', 'vk.ru', '+7000']) assert.ok(!text.includes(secret));

  // Доверенный сервис с ключом по-прежнему получает полную запись (ops/chat и др.).
  const trusted = await request('POST', '/leads', lead);
  assert.equal(trusted.status, 200);
  assert.equal(trusted.body.deduplicated, true);
  assert.equal(trusted.body.name, 'Синтетический Клиент');
});
