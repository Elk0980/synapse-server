'use strict';

/* Сквозная проверка с настоящим сервисом CRM (ops/crm/server.js во временном каталоге):
   заказ Palitra → одна заявка в CRM palitra-love; повтор без дубля; соседняя компания заявку не видит;
   CRM остановлена → заказ принят, после запуска CRM передача доходит. Сеть — только 127.0.0.1. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createSiteOrders } = require('./site-orders');
const { createSiteOrderCrmSync } = require('./site-order-crm');

const ORIGIN = 'https://palitra-love.ru';
const PRICE = JSON.stringify({ categories: [{ id: 'c', items: [{ id: 'bukety-1', title: 'Букет', price: '3 500 руб.' }] }] });
const SITES = { palitra: { companyCode: 'palitra-love', title: 'Palitra', origins: [ORIGIN] } };

async function startCrm(dir, apiKey, port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'crm', 'server.js')], {
    env: { ...process.env, API_KEY: apiKey, DATABASE_PATH: path.join(dir, 'crm.sqlite'), PORT: String(port), RATE_LIMIT_MAX: '10000' },
    stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let i = 0; i < 200; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/companies`, { headers: { 'x-api-key': apiKey } }); if (r.ok) return child; } catch { /* ждём запуска */ }
    if (child.exitCode !== null) throw new Error(stderr);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`CRM не запустилась: ${stderr}`);
}
const stopCrm = async (child) => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } };

test('заказ сайта становится заявкой CRM своей компании; повтор без дубля; CRM недоступна — передача повторяется', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-order-crm-'));
  const apiKey = crypto.randomBytes(24).toString('hex');
  const port = 40000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  let crm = await startCrm(dir, apiKey, port);
  try {
    const call = async (method, pathname, body) => {
      const r = await fetch(`${base}${pathname}`, { method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    for (const code of ['palitra-love', 'avokado-test']) assert.equal((await call('POST', '/companies', { code, name: code })).status, 201);
    const db = new DatabaseSync(':memory:');
    const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
    const orders = createSiteOrders({ db, tx, sites: SITES, priceReader: () => PRICE });
    const sync = createSiteOrderCrmSync({ db, sites: SITES, crmUrl: base, apiKey });
    const submit = () => orders.submit({ site: 'palitra', origin: ORIGIN, ip: '10.9.0.1', body: { requestId: crypto.randomUUID(), kind: 'cart',
      name: 'Анна', phone: '+7 900 000-00-01', consent: true, items: [{ id: 'bukety-1', qty: 1 }], utm: { utm_source: 'vk' } } });

    const first = submit();
    assert.equal(first.status, 201);
    await sync.sync();
    const own = (await call('GET', '/leads?companyCode=palitra-love')).body.leads;
    assert.equal(own.length, 1);
    assert.equal(own[0].channel, 'сайт · корзина');
    assert.equal(own[0].source, 'vk');
    assert.equal(own[0].stage, 'новая');
    assert.equal(own[0].saleAmount, null, 'сумма заказа — не продажа');
    assert.match(own[0].comment, new RegExp(`Заказ №${first.body.orderId}`));
    assert.equal(sync.status(first.body.orderId).leadId, own[0].id);
    assert.equal((await call('GET', '/leads?companyCode=avokado-test')).body.leads.length, 0, 'соседняя компания не получает');

    // Повтор передачи (потерянный ответ) — та же заявка.
    db.prepare("UPDATE site_orders SET crm_status='pending'").run();
    await sync.sync();
    assert.equal((await call('GET', '/leads?companyCode=palitra-love')).body.leads.length, 1);
    // Тот же номер заказа от имени другой компании CRM не перепривязывает.
    const ref = `site-order:palitra:${first.body.orderId}`;
    const foreign = await call('POST', '/internal/site-orders/lead', { companyCode: 'avokado-test', externalRef: ref, name: 'x', contact: '+79000000009' });
    assert.equal(foreign.status, 409);
    assert.equal(foreign.body.details.code, 'COMPANY_MISMATCH');
    // Без служебного ключа маршрут закрыт.
    const anonymous = await fetch(`${base}/internal/site-orders/lead`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anonymous.status, 401);

    // CRM остановлена: заказ принимается, передача ждёт; после запуска — доходит.
    await stopCrm(crm);
    const second = submit();
    assert.equal(second.status, 201);
    await sync.sync();
    assert.equal(sync.status(second.body.orderId).status, 'pending');
    assert.equal(sync.status(second.body.orderId).attempts, 1);
    crm = await startCrm(dir, apiKey, port);
    db.prepare('UPDATE site_orders SET crm_next_attempt_at=NULL WHERE id=?').run(second.body.orderId);
    await sync.sync();
    assert.equal(sync.status(second.body.orderId).status, 'sent');
    const after = (await call('GET', '/leads?companyCode=palitra-love')).body.leads;
    assert.equal(after.length, 2);
    assert.equal((await call('GET', '/leads?companyCode=avokado-test')).body.leads.length, 0);
  } finally {
    await stopCrm(crm);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
