'use strict';

/* Служебный приём заказов сайтов в реестр заявок: ключ повтора, компания, проверка полей,
   миграция leads.external_ref на базе прежней схемы и её откат. node --test ops/crm/site-order-leads.test.js */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { revertSiteOrderLeads } = require('./site-order-leads');

async function start(dbPath, apiKey, port) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, API_KEY: apiKey, DATABASE_PATH: dbPath, PORT: String(port), RATE_LIMIT_MAX: '10000' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let i = 0; i < 200; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/companies`, { headers: { 'x-api-key': apiKey } })).ok) return child; } catch { /* запуск */ }
    if (child.exitCode !== null) throw new Error(stderr);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(stderr);
}
const stop = async (child) => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } };

test('заказ сайта: одна заявка по номеру заказа, компания проверяется, прежняя схема мигрирует и откатывается', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-site-order-'));
  const dbPath = path.join(dir, 'crm.sqlite');
  const apiKey = randomBytes(24).toString('hex');
  const port = 40000 + Math.floor(Math.random() * 10000);
  const call = async (method, pathname, body, key = apiKey) => {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { ...(key ? { 'x-api-key': key } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  let child = await start(dbPath, apiKey, port);
  try {
    for (const code of ['palitra-love', 'other-co']) assert.equal((await call('POST', '/companies', { code, name: code })).status, 201);
    // Прежняя схема: колонки нет, в базе уже есть заявка с того же контакта.
    await stop(child);
    { const db = new DatabaseSync(dbPath); revertSiteOrderLeads(db);
      assert.equal(db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'external_ref'), false);
      db.prepare(`INSERT INTO leads(created_at,name,contact,normalized_contact,company_code) VALUES('2026-10-01T00:00:00Z','Старая','+79000000001','79000000001','palitra-love')`).run();
      db.close(); }
    child = await start(dbPath, apiKey, port);

    const order = { companyCode: 'palitra-love', externalRef: 'site-order:palitra:41', name: 'Анна', contact: '+7 900 000-00-01',
      channel: 'сайт · корзина', source: 'vk', comment: 'Заказ №41', utmSource: 'vk' };
    assert.equal((await call('POST', '/internal/site-orders/lead', order, '')).status, 401, 'только служебный вызов');
    assert.equal((await call('POST', '/internal/site-orders/lead', order, 'wrong')).status, 401);
    const created = await call('POST', '/internal/site-orders/lead', order);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('access-control-allow-origin'), null, 'служебный маршрут без CORS');
    assert.equal(created.body.duplicate, false);
    assert.equal(created.body.companyCode, 'palitra-love');
    const again = await call('POST', '/internal/site-orders/lead', { ...order, name: 'Иначе' });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.leadId, created.body.leadId);
    const leads = (await call('GET', '/leads?companyCode=palitra-love')).body.leads;
    assert.equal(leads.length, 2, 'прежняя заявка того же контакта + одна заявка заказа; по контакту не склеивается');
    const lead = leads.find((row) => row.id === created.body.leadId);
    assert.equal(lead.tag, 'site-order');
    assert.equal(lead.stage, 'новая');
    assert.equal(lead.saleAmount, null);
    assert.equal(leads.find((row) => row.name === 'Старая').contact, '+79000000001', 'прежняя строка цела');

    assert.equal((await call('POST', '/internal/site-orders/lead', { ...order, companyCode: 'other-co' })).body.details.code, 'COMPANY_MISMATCH');
    assert.equal((await call('GET', '/leads?companyCode=other-co')).body.leads.length, 0);
    const missing = await call('POST', '/internal/site-orders/lead', { ...order, companyCode: 'no-such', externalRef: 'site-order:palitra:42' });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.details.code, 'COMPANY_NOT_ACTIVE');
    for (const bad of [{ externalRef: 'order-42' }, { externalRef: 'site-order:palitra:0' }, { extra: 1 }, { name: '' }, { comment: 'x'.repeat(4001) }]) {
      assert.equal((await call('POST', '/internal/site-orders/lead', { ...order, externalRef: 'site-order:palitra:43', ...bad })).status, 400, JSON.stringify(Object.keys(bad)));
    }
    assert.equal((await call('GET', '/leads?companyCode=palitra-love')).body.leads.length, 2, 'отклонённые не создают заявок');
  } finally {
    await stop(child);
  }
  // Откат после работы: колонка и индекс уходят, заявки остаются.
  const db = new DatabaseSync(dbPath);
  revertSiteOrderLeads(db);
  assert.equal(db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'external_ref'), false);
  assert.equal(db.prepare("SELECT count(*) n FROM leads WHERE company_code='palitra-love'").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM lead_email_outbox WHERE lead_id IN (SELECT id FROM leads WHERE tag='site-order')").get().n, 0, 'письма о заявке заказа не ставятся');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
