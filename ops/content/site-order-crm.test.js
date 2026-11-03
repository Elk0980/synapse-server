'use strict';

/* Заказ сайта → заявка CRM: одна заявка на заказ, повтор без дубля, компания сайта, отказ CRM не ломает
   оформление и передача повторяется; миграция колонок на старой схеме и её откат.
   Только встроенные модули Node: node --test ops/content/site-order-crm.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSiteOrders } = require('./site-orders');
const { createSiteOrderCrmSync, revertSiteOrderCrm, leadPayload } = require('./site-order-crm');

const ORIGIN = 'https://palitra-love.ru';
const PRICE = JSON.stringify({ categories: [{ id: 'c', items: [
  { id: 'bukety-1', title: 'Букет «Нежность»', price: '3 500 руб.' },
  { id: 'shary-1', title: 'Шары', price: 'от 2 500 руб.' },
] }] });
const SITES = { palitra: { companyCode: 'palitra-love', title: 'Palitra', origins: [ORIGIN] } };

function txOf(db) {
  return (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
}
/* Поддельная CRM с той же идемпотентностью по externalRef, что и настоящая (см. интеграционный тест). */
function fakeCrm() {
  const state = { up: true, leads: [], calls: 0, status: null };
  const fetchImpl = async (url, init) => {
    state.calls += 1;
    if (!state.up) throw new Error('ECONNREFUSED');
    assert.equal(url, 'http://crm.test/internal/site-orders/lead');
    assert.equal(init.headers['x-api-key'], 'service-key');
    const body = JSON.parse(init.body);
    if (state.status) return new Response(JSON.stringify({ error: 'x', details: state.details }), { status: state.status });
    const found = state.leads.find((lead) => lead.externalRef === body.externalRef);
    if (found) return Response.json({ ok: true, leadId: found.id, companyCode: found.companyCode, duplicate: true });
    const lead = { id: state.leads.length + 1, ...body };
    state.leads.push(lead);
    return Response.json({ ok: true, leadId: lead.id, companyCode: lead.companyCode, duplicate: false }, { status: 201 });
  };
  return { state, fetchImpl };
}
function setup({ sites = SITES, crm = fakeCrm(), db = new DatabaseSync(':memory:') } = {}) {
  const clock = { at: Date.parse('2026-11-04T08:00:00Z') };
  const now = () => clock.at;
  const kicks = [];
  const orders = createSiteOrders({ db, tx: txOf(db), sites, priceReader: () => PRICE, now, onAccepted: (order) => kicks.push(order.id) });
  const sync = createSiteOrderCrmSync({ db, sites, crmUrl: 'http://crm.test/', apiKey: 'service-key', fetchImpl: crm.fetchImpl, now });
  const submit = (extra = {}) => orders.submit({ site: 'palitra', origin: ORIGIN, ip: `10.1.0.${Math.floor(Math.random() * 200)}`,
    body: { requestId: crypto.randomUUID(), kind: 'cart', name: 'Анна', phone: '+7 900 000-00-01', consent: true,
      items: [{ id: 'bukety-1', qty: 2 }, { id: 'shary-1', qty: 1 }], utm: { utm_source: 'vk', utm_campaign: 'nov' }, page: '/korzina', ...extra } });
  return { db, orders, sync, crm, clock, kicks, submit };
}

test('заказ → ровно одна заявка в CRM компании сайта; повтор передачи и повтор заказа без дубля', async () => {
  const { sync, crm, kicks, submit } = setup();
  const first = submit();
  assert.equal(first.status, 201);
  assert.deepEqual(kicks, [first.body.orderId], 'передача запускается после фиксации заказа');
  assert.equal(sync.status(first.body.orderId).status, 'pending');
  await sync.sync();
  assert.equal(crm.state.leads.length, 1);
  const lead = crm.state.leads[0];
  assert.equal(lead.companyCode, 'palitra-love');
  assert.equal(lead.externalRef, `site-order:palitra:${first.body.orderId}`);
  assert.equal(lead.channel, 'сайт · корзина');
  assert.equal(lead.source, 'vk');
  assert.equal(lead.utmCampaign, 'nov');
  assert.match(lead.comment, /Букет «Нежность» × 2; Шары × 1/);
  assert.match(lead.comment, /Сумма по известным ценам: 7\s000 ₽ \(ещё 1 поз\. уточняются\)/);
  assert.equal(sync.status(first.body.orderId).status, 'sent');
  assert.equal(sync.status(first.body.orderId).leadId, 1);
  await sync.sync();
  assert.equal(crm.state.calls, 1, 'переданный заказ повторно не отправляется');
  // Повтор того же requestId с сайта — тот же заказ, новой передачи нет.
  const body = { requestId: crypto.randomUUID(), kind: 'cart', name: 'Анна', phone: '+7 900 000-00-01', consent: true, items: [{ id: 'bukety-1', qty: 1 }] };
  const a = setup();
  const r1 = a.orders.submit({ site: 'palitra', origin: ORIGIN, ip: '10.2.0.1', body });
  const r2 = a.orders.submit({ site: 'palitra', origin: ORIGIN, ip: '10.2.0.1', body });
  assert.equal(r2.body.duplicate, true);
  assert.equal(r2.body.orderId, r1.body.orderId);
  await a.sync.sync(); await a.sync.sync();
  assert.equal(a.crm.state.leads.length, 1);
  // Неизвестный исход: CRM сохранила, ответ потерян — повтор возвращает ту же заявку.
  a.db.prepare("UPDATE site_orders SET crm_status='pending',crm_lead_id=NULL").run();
  await a.sync.sync();
  assert.equal(a.crm.state.leads.length, 1);
  assert.equal(a.sync.status(r1.body.orderId).status, 'sent');
});

test('CRM недоступна → заказ сохранён, передача повторяется с паузой и доходит', async () => {
  const { sync, crm, clock, submit, db } = setup();
  crm.state.up = false;
  const result = submit();
  assert.equal(result.status, 201, 'оформление не зависит от CRM');
  await sync.sync();
  let state = sync.status(result.body.orderId);
  assert.equal(state.status, 'pending');
  assert.equal(state.attempts, 1);
  assert.equal(state.error, 'CRM недоступна');
  assert.equal(db.prepare('SELECT count(*) n FROM site_orders').get().n, 1);
  await sync.sync();
  assert.equal(crm.state.calls, 1, 'до срока повтора CRM не опрашивается');
  crm.state.up = true;
  // 5xx — тоже временная ошибка.
  crm.state.status = 503; clock.at += 31 * 1000;
  await sync.sync();
  assert.equal(sync.status(result.body.orderId).attempts, 2);
  crm.state.status = null; clock.at += 61 * 1000;
  await sync.sync();
  state = sync.status(result.body.orderId);
  assert.equal(state.status, 'sent');
  assert.equal(crm.state.leads.length, 1);
});

test('компания: заказ уходит только в CRM компании сайта; расхождение и отказ CRM останавливают без дубля', async () => {
  const { db, sync, crm, submit } = setup();
  const own = submit();
  // Подмена компании в сохранённом заказе (или смена конфигурации) — отправки нет.
  db.prepare("UPDATE site_orders SET company_code='avokado' WHERE id=?").run(own.body.orderId);
  await sync.sync();
  assert.equal(crm.state.calls, 0);
  assert.equal(sync.status(own.body.orderId).status, 'error');
  // CRM: заказ закреплён за другой компанией — остановка, не повтор.
  const second = submit();
  crm.state.status = 409; crm.state.details = { code: 'COMPANY_MISMATCH' };
  await sync.sync();
  assert.equal(sync.status(second.body.orderId).status, 'error');
  // Компании ещё нет в CRM — повтор позже, а не потеря.
  const third = submit();
  crm.state.details = { code: 'COMPANY_NOT_ACTIVE' };
  await sync.sync();
  assert.equal(sync.status(third.body.orderId).status, 'pending');
  assert.equal(crm.state.leads.length, 0);
});

test('без служебного ключа передача не запускается, заказы ждут в очереди', async () => {
  const db = new DatabaseSync(':memory:');
  const orders = createSiteOrders({ db, tx: txOf(db), sites: SITES, priceReader: () => PRICE });
  const sync = createSiteOrderCrmSync({ db, sites: SITES, crmUrl: 'http://crm.test', apiKey: '', fetchImpl: async () => { throw new Error('не вызывать'); } });
  const r = orders.submit({ site: 'palitra', origin: ORIGIN, ip: '10.3.0.1', body: { requestId: crypto.randomUUID(), kind: 'request', name: 'Б', phone: '+79000000002', consent: true, items: [] } });
  assert.equal(sync.start(), false);
  assert.deepEqual(await sync.sync(), { configured: false, processed: 0 });
  assert.equal(sync.status(r.body.orderId).status, 'pending');
  const payload = leadPayload(db.prepare('SELECT * FROM site_orders').get(), SITES.palitra);
  assert.equal(payload.channel, 'сайт · форма');
  assert.equal(payload.source, 'сайт · форма');
  assert.equal(payload.comment.includes('Сумма'), false, 'без корзины суммы нет');
});

test('миграция на старой схеме: прежние заказы не уходят автоматически; откат возвращает прежнюю схему', async () => {
  const db = new DatabaseSync(':memory:');
  // Схема site_orders до этой задачи (с колонками прежних миграций).
  db.exec(`CREATE TABLE site_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, company_code TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cart','request')),
      status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','notified','notify_uncertain','notify_failed')),
      name TEXT NOT NULL, phone TEXT NOT NULL, phone_normalized TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL, known_total INTEGER NOT NULL DEFAULT 0, unknown_count INTEGER NOT NULL DEFAULT 0,
      page TEXT NOT NULL DEFAULT '', utm_json TEXT NOT NULL DEFAULT '{}', ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, notified_at TEXT, UNIQUE(site, request_id));
    INSERT INTO site_orders(site,company_code,request_id,fingerprint,kind,name,phone,phone_normalized,items_json,ip_hash,created_at)
      VALUES('palitra','palitra-love','00000000-0000-4000-8000-000000000001','f','request','Старый','+79000000003','79000000003','[]','h','2026-10-01T00:00:00Z');`);
  const crm = fakeCrm();
  const { sync, submit } = setup({ db, crm });
  const old = db.prepare('SELECT * FROM site_orders WHERE id=1').get();
  assert.equal(old.crm_status, '');
  assert.equal(old.name, 'Старый');
  const fresh = submit();
  await sync.sync();
  assert.equal(crm.state.leads.length, 1, 'передан только новый заказ');
  assert.equal(crm.state.leads[0].externalRef, `site-order:palitra:${fresh.body.orderId}`);
  revertSiteOrderCrm(db);
  const columns = db.prepare("SELECT name FROM pragma_table_info('site_orders')").all().map((row) => row.name);
  assert.equal(columns.some((name) => name.startsWith('crm_')), false);
  assert.equal(db.prepare('SELECT count(*) n FROM site_orders').get().n, 2, 'откат не теряет заказы');
  // Повторный запуск снова добавляет колонки (идемпотентно).
  createSiteOrders({ db, tx: txOf(db), sites: SITES, priceReader: () => PRICE });
  assert.ok(db.prepare("SELECT name FROM pragma_table_info('site_orders')").all().some((row) => row.name === 'crm_status'));
});
