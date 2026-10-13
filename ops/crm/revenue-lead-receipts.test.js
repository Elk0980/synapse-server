'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {
  createRevenueLeadReceipts,
  sanitizeDeclaredLabel,
  sanitizeLandingHost,
  TIMEZONES,
  WRITER_VERSION,
  COVERAGE_PROTOCOL,
} = require('./revenue-lead-receipts');

// Повторяет показанную схему leads из ops/crm/server.js (L106-121, L225-228, L552-566).
// lead_email_outbox — тестовая замена outbox: реальная схема в выданных excerpts не показана.
function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS companies (code TEXT PRIMARY KEY COLLATE NOCASE, is_deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      channel TEXT, source TEXT, tag TEXT, page TEXT, first_question TEXT,
      stage TEXT NOT NULL DEFAULT 'новая',
      sale_amount REAL, sold_at TEXT, comment TEXT,
      company_code TEXT COLLATE NOCASE REFERENCES companies(code) ON UPDATE CASCADE ON DELETE RESTRICT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
      client_id TEXT, referrer TEXT, landing_page TEXT, normalized_contact TEXT
    );
    CREATE TABLE IF NOT EXISTS lead_email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, repeated INTEGER NOT NULL, payload TEXT NOT NULL
    );
    INSERT OR IGNORE INTO companies(code) VALUES ('alvi'), ('avocado');
  `);
  return db;
}

function makeClock(iso) {
  const clock = {ms: Date.parse(iso)};
  clock.set = (value) => { clock.ms = Date.parse(value); };
  clock.now = () => clock.ms;
  return clock;
}

// Детерминированные непрозрачные UUID для тестов; Root по умолчанию использует crypto.randomUUID.
function uuidSource() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const plain = (rows) => rows.map((row) => ({...row}));

function insertLead(db, {createdAt, companyCode = 'alvi', name = 'Иван Петров', contact = '+7 999 123-45-67'}) {
  const result = db.prepare(`
    INSERT INTO leads (created_at, name, contact, normalized_contact, source, utm_source, client_id, landing_page, company_code)
    VALUES (?, ?, ?, ?, 'vk', 'vk', 'browser-abc-123', 'https://alvi.example/promo?phone=79991234567', ?)
  `).run(createdAt, name, contact, contact.replace(/\D/g, ''), companyCode);
  return Number(result.lastInsertRowid);
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Модель обеих веток POST /leads: бизнес-строка и outbox вызывающего кода плюс receipt в одной транзакции.
function acceptCreated(db, receipts, clock, {companyCode = 'alvi', declared = {}, contact} = {}) {
  return inTransaction(db, () => {
    const leadId = insertLead(db, {createdAt: new Date(clock.ms).toISOString(), companyCode, contact});
    db.prepare('INSERT INTO lead_email_outbox (lead_id, repeated, payload) VALUES (?, 0, ?)').run(leadId, 'new');
    receipts.appendAccepted({companyCode, leadId, outcome: 'created', originState: 'matched', declared});
    return leadId;
  });
}

function acceptDuplicate(db, receipts, leadId, {companyCode = 'alvi', declared = {}} = {}) {
  return inTransaction(db, () => {
    db.prepare('INSERT INTO lead_email_outbox (lead_id, repeated, payload) VALUES (?, 1, ?)').run(leadId, 'repeat');
    return receipts.appendAccepted({companyCode, leadId, outcome: 'deduplicated', originState: 'matched', declared});
  });
}

const receiptRows = (db) => plain(db.prepare('SELECT * FROM revenue_lead_receipts ORDER BY id').all());
const eventRows = (db) => plain(db.prepare(
  'SELECT session_id, kind, occurred_at FROM revenue_lead_writer_events ORDER BY id').all())
  .map((row) => [row.session_id, row.kind, row.occurred_at]);
const startCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM revenue_lead_writer_events WHERE kind = 'start'").get().n;
const ZERO = Object.freeze({total: 0, created: 0, deduplicated: 0});
const utcDay = (receipts, date, to = date) => receipts.journal({companyCode: 'alvi', from: date, to, timezone: 'UTC'});

test('конструктор пустой таблицы не доказывает захват: unknown, а не ноль', () => {
  const db = openDb();
  const clock = makeClock('2026-10-20T00:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  insertLead(db, {createdAt: '2026-10-12T10:00:00.000Z'});
  const result = receipts.journal({companyCode: 'alvi', from: '2026-10-12', to: '2026-10-12', timezone: 'Europe/Moscow'});
  assert.equal(result.completeness, 'unknown');
  assert.deepEqual(result.reasons, ['writer_not_activated']);
  assert.equal(result.knownReceiptCounts, null);
  assert.equal(result.writer.status, 'not_activated');
  assert.equal(result.writer.since, null);
  assert.equal(result.writer.fullPeriodCovered, false);
  assert.equal(result.writer.protocol, COVERAGE_PROTOCOL);
  assert.equal(result.writer.lastConfirmedActiveAt, null);
  assert.deepEqual(result.writer.coveredIntervals, []);
  assert.equal(result.legacyLeadRowsCount, 1);
  assert.equal(result.trust, 'declared_public');
  assert.equal(result.firstTouch, 'unknown');
  assert.equal(result.nativeLinks, 'missing');
  assert.equal(result.leadsWithoutBooking, 'unavailable');
  assert.equal(result.economics, 'unavailable');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revenue_lead_receipt_writer').get().n, 0);
  // Повторное создание модуля на той же базе идемпотентно и тоже не активирует writer.
  createRevenueLeadReceipts(db, {now: clock.now});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revenue_lead_receipt_writer').get().n, 0);
  assert.equal(startCount(db), 0);
});

test('activateWriter: новая сессия на каждый экземпляр, повтор в экземпляре идемпотентен, первый stamp — история', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T09:00:00.000Z');
  const ids = uuidSource();
  const receipts = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
  assert.throws(() => receipts.activateWriter({version: 'lead-receipts/v2'}), {code: 'LEAD_RECEIPT_WRITER_VERSION'});
  assert.throws(() => receipts.activateWriter(), {code: 'LEAD_RECEIPT_WRITER_VERSION'});
  assert.throws(() => inTransaction(db, () => receipts.activateWriter({version: WRITER_VERSION})),
    {code: 'LEAD_RECEIPT_ACTIVATION_IN_TRANSACTION'});
  assert.equal(startCount(db), 0);
  const first = receipts.activateWriter({version: WRITER_VERSION});
  assert.deepEqual(first, {version: 'lead-receipts/v1', activatedAt: '2026-10-13T09:00:00.000Z',
    sessionId: uuid(1), sessionStartedAt: '2026-10-13T09:00:00.000Z'});
  clock.set('2026-10-14T09:00:00.000Z');
  assert.deepEqual(receipts.activateWriter({version: WRITER_VERSION}), first);
  assert.equal(startCount(db), 1);

  const restarted = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
  assert.deepEqual(restarted.activateWriter({version: WRITER_VERSION}), {version: 'lead-receipts/v1',
    activatedAt: '2026-10-13T09:00:00.000Z', sessionId: uuid(2), sessionStartedAt: '2026-10-14T09:00:00.000Z'});
  assert.equal(startCount(db), 2);

  // PID, повтор чужого id, верхний регистр и не-строка не принимаются как sessionId; сессия не создаётся.
  for (const randomUUID of [() => String(process.pid), () => uuid(1), () => 'ABCDEF00-0000-4000-8000-000000000003', () => null]) {
    const bad = createRevenueLeadReceipts(db, {now: clock.now, randomUUID});
    assert.throws(() => bad.activateWriter({version: WRITER_VERSION}), {code: 'LEAD_RECEIPT_WRITER_SESSION_INVALID'});
  }
  assert.equal(startCount(db), 2);
  const bare = createRevenueLeadReceipts({exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql)},
    {now: clock.now, randomUUID: ids});
  assert.throws(() => bare.activateWriter({version: WRITER_VERSION}), {code: 'LEAD_RECEIPT_ACTIVATION_IN_TRANSACTION'});

  assert.throws(() => db.exec("UPDATE revenue_lead_receipt_writer SET activated_ms = 1, activated_at = '1970-01-01T00:00:00.001Z'"),
    /immutable/);
  assert.throws(() => db.exec('DELETE FROM revenue_lead_receipt_writer'), /immutable/);
  assert.throws(() => db.exec(
    "INSERT OR REPLACE INTO revenue_lead_receipt_writer (id, version, activated_at, activated_ms) VALUES (1, 'lead-receipts/v1', '1970-01-01T00:00:00.001Z', 1)"
  ), /immutable/);
  assert.equal(db.prepare('SELECT activated_at FROM revenue_lead_receipt_writer').get().activated_at, '2026-10-13T09:00:00.000Z');
  assert.match(createRevenueLeadReceipts(openDb(), {now: clock.now}).activateWriter({version: WRITER_VERSION}).sessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('обе ветки и повторы: каждая принятая попытка получает receipt с часами сервера', () => {
  const db = openDb();
  const clock = makeClock('2026-10-01T00:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T07:00:00.000Z');
  const leadId = acceptCreated(db, receipts, clock, {declared: {source: 'vk', utmCampaign: 'autumn'}});
  clock.set('2026-10-13T07:05:00.000Z');
  const repeat1 = acceptDuplicate(db, receipts, leadId, {declared: {source: 'telegram'}});
  clock.set('2026-10-13T07:06:00.000Z');
  const repeat2 = acceptDuplicate(db, receipts, leadId);
  assert.equal(repeat1.receivedAt, '2026-10-13T07:05:00.000Z');
  assert.ok(repeat2.receiptId > repeat1.receiptId);
  clock.set('2026-10-13T08:00:00.000Z');
  acceptCreated(db, receipts, clock, {contact: 'other@mail.example'});

  const rows = receiptRows(db);
  assert.deepEqual(rows.map((row) => [row.outcome, row.lead_id, row.received_at]), [
    ['created', leadId, '2026-10-13T07:00:00.000Z'],
    ['deduplicated', leadId, '2026-10-13T07:05:00.000Z'],
    ['deduplicated', leadId, '2026-10-13T07:06:00.000Z'],
    ['created', leadId + 1, '2026-10-13T08:00:00.000Z'],
  ]);
  assert.equal(rows[1].declared_source, 'telegram');
  assert.equal(rows[0].utm_campaign, 'autumn');
  assert.ok(rows.every((row) => row.trust === 'declared_public' && row.writer_version === 'lead-receipts/v1'));
  // Активный писатель подтверждает интервал heartbeat-событием в той же транзакции.
  assert.deepEqual(eventRows(db).map(([, kind, at]) => [kind, at]), [
    ['start', '2026-10-01T00:00:00.000Z'],
    ['heartbeat', '2026-10-13T07:00:00.000Z'],
    ['heartbeat', '2026-10-13T07:05:00.000Z'],
    ['heartbeat', '2026-10-13T07:06:00.000Z'],
    ['heartbeat', '2026-10-13T08:00:00.000Z'],
  ]);

  clock.set('2026-10-20T00:00:00.000Z');
  const result = receipts.journal({companyCode: 'ALVI', from: '2026-10-13', to: '2026-10-13', timezone: 'UTC'});
  assert.equal(result.companyCode, 'alvi');
  assert.equal(result.completeness, 'captured_since');
  assert.deepEqual(result.knownReceiptCounts, {total: 4, created: 2, deduplicated: 2});
  assert.equal(result.countsAreLowerBound, false);
  assert.equal(result.countBasis, 'accepted_http_attempts_not_unique_leads');
  assert.equal(result.legacyLeadRowsCount, 2);

  // Повторный created для той же строки невозможен: строка leads создаётся один раз.
  assert.throws(() => inTransaction(db, () => receipts.appendAccepted(
    {companyCode: 'alvi', leadId, outcome: 'created', originState: 'matched', declared: {}})), /append-only/);
  assert.equal(receiptRows(db).length, 4);
});

test('контекст: поля времени/касаний/native от вызывающего кода и неверные значения отклоняются', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T07:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  const leadId = insertLead(db, {createdAt: '2026-10-13T07:00:00.000Z'});
  const base = {companyCode: 'alvi', leadId, outcome: 'deduplicated', originState: 'missing', declared: {}};
  const bad = [
    {...base, receivedAt: '2020-01-01T00:00:00.000Z'},
    {...base, firstTouch: '2020-01-01'},
    {...base, recordId: 77},
    {...base, paymentHistory: []},
    {...base, vat: 20},
    {...base, proof: 'x'},
    {...base, sessionId: uuid(1)},
    {...base, declared: {name: 'Иван'}},
    {...base, declared: {clientId: 'browser-1'}},
    {...base, declared: 'vk'},
    {...base, leadId: 0},
    {...base, leadId: 1.5},
    {...base, leadId: String(leadId)},
    {...base, leadId: Number.MAX_SAFE_INTEGER + 1},
    {...base, outcome: 'merged'},
    {...base, originState: 'verified'},
    {...base, companyCode: ''},
    {...base, companyCode: 5},
    {leadId, outcome: 'created', originState: 'matched'},
    null,
  ];
  for (const context of bad) {
    assert.throws(() => inTransaction(db, () => receipts.appendAccepted(context)), {code: 'LEAD_RECEIPT_CONTEXT_INVALID'});
  }
  assert.throws(() => inTransaction(db, () => receipts.appendAccepted({...base, leadId: 999})), {code: 'LEAD_RECEIPT_LEAD_NOT_FOUND'});
  assert.equal(receiptRows(db).length, 0);

  const brokenClock = createRevenueLeadReceipts(db, {now: () => Number.NaN});
  assert.throws(() => inTransaction(db, () => brokenClock.appendAccepted(base)), {code: 'LEAD_RECEIPT_CLOCK_INVALID'});
  assert.equal(receiptRows(db).length, 0);
});

test('append без подтверждённой транзакции отклоняется: false, отсутствующий или не-boolean isTransaction', () => {
  const db = openDb();
  assert.equal(typeof db.isTransaction, 'boolean', 'Node, на котором проверен модуль, сообщает isTransaction');
  const clock = makeClock('2026-10-13T07:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  const leadId = insertLead(db, {createdAt: '2026-10-13T07:00:00.000Z'});
  const context = {companyCode: 'alvi', leadId, outcome: 'created', originState: 'matched'};
  assert.equal(db.isTransaction, false);
  assert.throws(() => receipts.appendAccepted(context), {code: 'LEAD_RECEIPT_TRANSACTION_REQUIRED'});
  const wrappers = [
    {exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql)},
    {exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql), get isTransaction() { return db.isTransaction ? 1 : 0; }},
  ];
  for (const wrapper of wrappers) {
    const wrapped = createRevenueLeadReceipts(wrapper, {now: clock.now});
    // Настоящая транзакция открыта, но модуль не может её подтвердить — тихой записи нет.
    assert.throws(() => inTransaction(db, () => wrapped.appendAccepted(context)), {code: 'LEAD_RECEIPT_TRANSACTION_REQUIRED'});
  }
  assert.equal(receiptRows(db).length, 0);
  inTransaction(db, () => {
    assert.equal(db.isTransaction, true);
    receipts.appendAccepted(context);
  });
  assert.equal(receiptRows(db).length, 1);
});

test('откат транзакции вызывающего кода убирает receipt, heartbeat, бизнес-строку и outbox', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T07:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T07:30:00.000Z');
  assert.throws(() => inTransaction(db, () => {
    const leadId = insertLead(db, {createdAt: '2026-10-13T07:30:00.000Z'});
    db.prepare('INSERT INTO lead_email_outbox (lead_id, repeated, payload) VALUES (?, 0, ?)').run(leadId, 'new');
    receipts.appendAccepted({companyCode: 'alvi', leadId, outcome: 'created', originState: 'matched'});
    throw new Error('SMTP enqueue failed after receipt');
  }), /SMTP enqueue failed/);
  assert.equal(receiptRows(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_email_outbox').get().n, 0);
  assert.deepEqual(eventRows(db).map(([, kind]) => kind), ['start'], 'heartbeat откатился вместе с receipt');

  const leadId = acceptCreated(db, receipts, clock);
  clock.set('2026-10-13T08:00:00.000Z');
  assert.throws(() => inTransaction(db, () => {
    receipts.appendAccepted({companyCode: 'alvi', leadId, outcome: 'deduplicated', originState: 'matched'});
    throw new Error('dedup response failed');
  }), /dedup response failed/);
  assert.deepEqual(receiptRows(db).map((row) => row.outcome), ['created']);
  assert.deepEqual(eventRows(db).map(([, kind, at]) => [kind, at]),
    [['start', '2026-10-13T07:00:00.000Z'], ['heartbeat', '2026-10-13T07:30:00.000Z']]);
  // Транзакция продолжает работать после отката: следующий повтор фиксируется.
  acceptDuplicate(db, receipts, leadId);
  assert.deepEqual(receiptRows(db).map((row) => row.outcome), ['created', 'deduplicated']);
  assert.equal(eventRows(db).length, 3);
});

test('чужая компания, отсутствующая строка и NULL-контекст legacy', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T07:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  receipts.activateWriter({version: WRITER_VERSION});
  const alviLead = insertLead(db, {createdAt: '2026-10-13T07:00:00.000Z', companyCode: 'alvi'});
  const unassigned = insertLead(db, {createdAt: '2026-10-13T07:00:00.000Z', companyCode: null});
  const append = (context) => inTransaction(db, () => receipts.appendAccepted(
    {outcome: 'deduplicated', originState: 'unknown', declared: {}, ...context}));

  assert.throws(() => append({companyCode: 'avocado', leadId: alviLead}), {code: 'LEAD_RECEIPT_COMPANY_MISMATCH'});
  assert.throws(() => append({companyCode: null, leadId: alviLead}), {code: 'LEAD_RECEIPT_COMPANY_MISMATCH'});
  assert.throws(() => append({companyCode: 'alvi', leadId: unassigned}), {code: 'LEAD_RECEIPT_COMPANY_MISMATCH'});
  assert.equal(receiptRows(db).length, 0);

  append({companyCode: 'ALVI', leadId: alviLead});
  append({companyCode: null, leadId: unassigned});
  const rows = receiptRows(db);
  assert.deepEqual(rows.map((row) => row.company_code), ['alvi', null]);

  clock.set('2026-10-20T00:00:00.000Z');
  const alvi = receipts.journal({companyCode: 'alvi', from: '2026-10-13', to: '2026-10-13', timezone: 'UTC'});
  assert.deepEqual(alvi.knownReceiptCounts, {total: 1, created: 0, deduplicated: 1});
  const avocado = receipts.journal({companyCode: 'avocado', from: '2026-10-13', to: '2026-10-13', timezone: 'UTC'});
  assert.deepEqual(avocado.knownReceiptCounts, ZERO);
  for (const companyCode of [null, undefined, '', '   ']) {
    assert.throws(() => receipts.journal({companyCode, from: '2026-10-13', to: '2026-10-13', timezone: 'UTC'}),
      {code: 'LEAD_RECEIPT_QUERY_INVALID'});
  }
});

test('после смены компании строки leads receipt сохраняет исходную компанию; удаление строки leads не блокируется', () => {
  const db = openDb();
  const clock = makeClock('2026-10-01T00:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T07:00:00.000Z');
  const leadId = acceptCreated(db, receipts, clock, {companyCode: 'alvi'});
  db.prepare("UPDATE leads SET company_code = 'avocado' WHERE id = ?").run(leadId);

  clock.set('2026-10-13T08:00:00.000Z');
  assert.throws(() => acceptDuplicate(db, receipts, leadId, {companyCode: 'alvi'}), {code: 'LEAD_RECEIPT_COMPANY_MISMATCH'});
  acceptDuplicate(db, receipts, leadId, {companyCode: 'avocado'});

  clock.set('2026-10-20T00:00:00.000Z');
  const query = {from: '2026-10-13', to: '2026-10-13', timezone: 'Europe/Moscow'};
  const alvi = receipts.journal({...query, companyCode: 'alvi'});
  const avocado = receipts.journal({...query, companyCode: 'avocado'});
  assert.deepEqual(alvi.knownReceiptCounts, {total: 1, created: 1, deduplicated: 0});
  assert.deepEqual(avocado.knownReceiptCounts, {total: 1, created: 0, deduplicated: 1});
  assert.equal(alvi.legacyLeadRowsCount, 0);
  assert.equal(avocado.legacyLeadRowsCount, 1);

  db.prepare('DELETE FROM lead_email_outbox WHERE lead_id = ?').run(leadId);
  db.prepare('DELETE FROM leads WHERE id = ?').run(leadId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);
  assert.deepEqual(receiptRows(db).map((row) => [row.company_code, row.lead_id]), [['alvi', leadId], ['avocado', leadId]]);
  assert.deepEqual(receipts.journal({...query, companyCode: 'alvi'}).knownReceiptCounts, {total: 1, created: 1, deduplicated: 0});
});

test('в журнал не попадают PII, URL-детали и небезопасные метки; форма не отклоняется', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T07:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: uuidSource()});
  receipts.activateWriter({version: WRITER_VERSION});
  const declared = {
    source: 'ivan.petrov@mail.example',
    utmSource: '+7 999 123-45-67',
    utmMedium: 'cpc',
    utmCampaign: 'spring_promo',
    utmContent: 'https://evil.example/x?phone=79991234567',
    utmTerm: 'стрижка',
    landingPage: 'https://user:secret-pass@ALVI.Example/path/Ivan?phone=79991234567&name=Ivan#frag',
  };
  clock.set('2026-10-13T07:01:00.000Z');
  acceptCreated(db, receipts, clock, {declared});
  const [row] = receiptRows(db);
  assert.equal(row.declared_source, null);
  assert.equal(row.utm_source, null);
  assert.equal(row.utm_medium, 'cpc');
  assert.equal(row.utm_campaign, 'spring_promo');
  assert.equal(row.utm_content, null);
  assert.equal(row.utm_term, 'стрижка');
  assert.equal(row.landing_host, 'alvi.example');
  const serialized = JSON.stringify([receiptRows(db), eventRows(db)]);
  for (const secret of ['Иван', 'Ivan', 'ivan', 'secret-pass', '7999', '999 123', 'mail.example', 'browser-abc', 'phone', '/path']) {
    assert.ok(!serialized.includes(secret), `receipt/event содержит ${secret}`);
  }
  assert.deepEqual(eventRows(db).map(([sessionId]) => sessionId), [uuid(1), uuid(1)]);
  const columns = db.prepare('PRAGMA table_info(revenue_lead_receipts)').all().map((column) => column.name);
  for (const forbidden of ['name', 'contact', 'normalized_contact', 'client_id', 'comment', 'first_question', 'referrer', 'page', 'landing_page']) {
    assert.ok(!columns.includes(forbidden), `колонка ${forbidden}`);
  }
  const eventColumns = db.prepare('PRAGMA table_info(revenue_lead_writer_events)').all().map((column) => column.name);
  assert.deepEqual(eventColumns, ['id', 'session_id', 'kind', 'version', 'occurred_at', 'occurred_ms']);

  assert.equal(sanitizeDeclaredLabel('  vk  '), 'vk');
  assert.equal(sanitizeDeclaredLabel('промо 2026'), 'промо 2026');
  assert.equal(sanitizeDeclaredLabel('tiktok'), 'tiktok');
  for (const value of ['campaign1234567', '8 (999) 123 45 67', 'a'.repeat(201), 'line\nbreak', 'utm=1&x=2', 'a%40b',
    'x:y', 'a/b', 'q?', '', '   ', 123, null, undefined, {}, ['vk'], '١٢٣٤٥٦٧٨']) {
    assert.equal(sanitizeDeclaredLabel(value), null, JSON.stringify(value));
  }
  assert.equal(sanitizeLandingHost('https://alvi.example./'), 'alvi.example');
  assert.equal(sanitizeLandingHost('http://xn--80ak6aa92e.com/a?b'), 'xn--80ak6aa92e.com');
  for (const value of ['javascript:alert(1)', '/promo?phone=1', 'ftp://alvi.example', 'https://79991234567.example.com/',
    'http://[::1]/', 'data:text/html,hi', 'not a url', 'https://' + 'a'.repeat(2050) + '.example', 42, null]) {
    assert.equal(sanitizeLandingHost(value), null, String(value).slice(0, 40));
  }
});

test('модуль только читает id/company_code из leads и не трогает бизнес-строки и outbox', () => {
  const real = openDb();
  const log = [];
  const recording = {
    exec(sql) { log.push(sql); return real.exec(sql); },
    prepare(sql) { log.push(sql); return real.prepare(sql); },
    get isTransaction() { return real.isTransaction; },
  };
  const clock = makeClock('2026-10-01T00:00:00.000Z');
  const receipts = createRevenueLeadReceipts(recording, {now: clock.now});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T07:00:00.000Z');
  const leadId = acceptCreated(real, receipts, clock, {declared: {source: 'vk'}});
  const leadsBefore = plain(real.prepare('SELECT * FROM leads ORDER BY id').all());
  const outboxBefore = plain(real.prepare('SELECT * FROM lead_email_outbox ORDER BY id').all());
  clock.set('2026-10-13T07:01:00.000Z');
  inTransaction(real, () => receipts.appendAccepted({companyCode: 'alvi', leadId, outcome: 'deduplicated', originState: 'matched'}));
  clock.set('2026-10-13T07:02:00.000Z');
  receipts.heartbeatWriter();
  clock.set('2026-10-20T00:00:00.000Z');
  const changesBefore = real.prepare('SELECT total_changes() AS n').get().n;
  receipts.journal({companyCode: 'alvi', from: '2026-10-01', to: '2026-10-19', timezone: 'Asia/Irkutsk'});
  assert.equal(real.prepare('SELECT total_changes() AS n').get().n, changesBefore, 'journal ничего не пишет');
  receipts.closeWriter();
  assert.deepEqual(plain(real.prepare('SELECT * FROM leads ORDER BY id').all()), leadsBefore);
  assert.deepEqual(plain(real.prepare('SELECT * FROM lead_email_outbox ORDER BY id').all()), outboxBefore);

  assert.ok(log.length > 0);
  for (const sql of log) {
    const foreign = sql.replace(/revenue_lead_\w+/g, '').replace(/\s+/g, ' ');
    assert.doesNotMatch(foreign, /\b(INSERT|UPDATE|DELETE|REPLACE)\b(?! ON\b)[^;]*\b(leads|lead_email_outbox|stage_history|companies)\b/i, sql);
    assert.doesNotMatch(foreign, /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b(?! SELECT RAISE)/i, sql);
    assert.doesNotMatch(foreign, /\b(fetch|http|yclients)\b/i, sql);
    if (/\bleads\b/i.test(foreign)) {
      assert.match(foreign.trim(), /^SELECT (id, company_code|COUNT\(\*\) AS count) FROM leads WHERE /, sql);
    }
  }
});

test('UPDATE/DELETE/REPLACE receipt, meta и runtime-событий блокируются; честный heartbeat дописывается', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T07:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: uuidSource()});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T07:01:00.000Z');
  acceptCreated(db, receipts, clock);
  clock.set('2026-10-13T07:02:00.000Z');
  assert.deepEqual(receipts.heartbeatWriter(), {sessionId: uuid(1), confirmedAt: '2026-10-13T07:02:00.000Z'});
  const before = receiptRows(db);
  assert.throws(() => db.exec("UPDATE revenue_lead_receipts SET received_at = '2020-01-01T00:00:00.000Z', received_ms = 1"), /append-only/);
  assert.throws(() => db.exec("UPDATE revenue_lead_receipts SET company_code = 'avocado'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM revenue_lead_receipts'), /append-only/);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO revenue_lead_receipts
    (id, received_at, received_ms, company_code, lead_id, outcome, origin_state, writer_version)
    VALUES (${before[0].id}, '2020-01-01T00:00:00.000Z', 1, 'avocado', ${before[0].lead_id}, 'deduplicated', 'matched', 'x')`), /append-only/);
  assert.throws(() => db.exec(`INSERT INTO revenue_lead_receipts
    (received_at, received_ms, company_code, lead_id, outcome, origin_state, writer_version, trust)
    VALUES ('2026-10-13T07:00:00.000Z', 1, 'alvi', 1, 'deduplicated', 'matched', 'x', 'verified')`), /CHECK/);
  assert.deepEqual(receiptRows(db), before);

  const events = eventRows(db);
  assert.equal(events.length, 3);
  const insertEvent = (sessionId, kind, iso, id = null) => db.prepare(`INSERT OR REPLACE INTO revenue_lead_writer_events
    (id, session_id, kind, version, occurred_at, occurred_ms) VALUES (?, ?, ?, 'lead-receipts/v1', ?, ?)`)
    .run(id, sessionId, kind, iso, Date.parse(iso));
  assert.throws(() => db.exec('UPDATE revenue_lead_writer_events SET occurred_ms = occurred_ms + 86400000'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM revenue_lead_writer_events'), /append-only/);
  assert.throws(() => insertEvent(uuid(1), 'heartbeat', '2026-10-30T00:00:00.000Z', 1), /append-only/);
  assert.throws(() => insertEvent(uuid(1), 'start', '2026-10-01T00:00:00.000Z'), /append-only/);
  assert.throws(() => insertEvent(uuid(1), 'heartbeat', '2026-10-13T07:01:30.000Z'), /append-only/, 'время назад');
  assert.throws(() => insertEvent(uuid(9), 'heartbeat', '2026-10-13T08:00:00.000Z'), /append-only/, 'без start');
  assert.throws(() => insertEvent('pid-1234', 'start', '2026-10-13T08:00:00.000Z'), /CHECK/);
  assert.throws(() => insertEvent(uuid(1), 'pause', '2026-10-13T08:00:00.000Z'), /CHECK/);
  assert.deepEqual(eventRows(db), events);
});

test('невозможные даты, неверный порядок и часовой пояс вне списка отклоняются; список зон точный', () => {
  const db = openDb();
  const receipts = createRevenueLeadReceipts(db, {now: makeClock('2026-10-20T00:00:00.000Z').now});
  const base = {companyCode: 'alvi', from: '2026-10-01', to: '2026-10-02', timezone: 'Europe/Moscow'};
  const bad = [
    {from: '2026-02-30'}, {to: '2025-02-29'}, {from: '2026-13-01'}, {from: '2026-00-10'}, {from: '2026-1-01'},
    {from: '2026-10-01T00:00:00Z'}, {from: 20261001}, {from: undefined}, {from: '1969-12-31'},
    {from: '2026-10-03'}, {timezone: 'America/Los_Angeles'}, {timezone: 'europe/moscow'}, {timezone: 'asia/bangkok'},
    {timezone: undefined}, {extra: 1},
  ];
  for (const patch of bad) {
    assert.throws(() => receipts.journal({...base, ...patch}), {code: 'LEAD_RECEIPT_QUERY_INVALID'}, JSON.stringify(patch));
  }
  assert.throws(() => receipts.journal(null), {code: 'LEAD_RECEIPT_QUERY_INVALID'});
  assert.equal(receipts.journal({...base, from: '2024-02-29', to: '2024-02-29'}).period.startUtc, '2024-02-28T21:00:00.000Z');
  assert.deepEqual(TIMEZONES, ['Asia/Irkutsk', 'Europe/Moscow', 'Asia/Bangkok', 'UTC']);
  assert.ok(Object.isFrozen(TIMEZONES));
  assert.equal(receipts.journal({...base, timezone: 'Asia/Bangkok'}).period.startUtc, '2026-09-30T17:00:00.000Z');
  assert.equal(receipts.journal({...base, timezone: 'Asia/Bangkok'}).period.endUtcExclusive, '2026-10-02T17:00:00.000Z');
  assert.equal(receipts.journal({...base, timezone: 'Asia/Irkutsk'}).period.startUtc, '2026-09-30T16:00:00.000Z');
  assert.equal(receipts.journal({...base, timezone: 'UTC'}).period.startUtc, '2026-10-01T00:00:00.000Z');

  const custom = createRevenueLeadReceipts(db, {now: () => Date.parse('2026-10-20T00:00:00.000Z'), timezones: ['UTC']});
  assert.equal(custom.journal({...base, timezone: 'UTC'}).period.startUtc, '2026-10-01T00:00:00.000Z');
  assert.throws(() => custom.journal(base), {code: 'LEAD_RECEIPT_QUERY_INVALID'});
  assert.throws(() => createRevenueLeadReceipts(db, {timezones: ['Mars/Olympus']}), RangeError);
  assert.throws(() => createRevenueLeadReceipts(db, {timezones: []}), TypeError);
  assert.throws(() => createRevenueLeadReceipts(db, {randomUUID: 'x'}), TypeError);
});

test('границы суток UTC: Москва, Иркутск и Бангкок дают разные полуоткрытые периоды', () => {
  const db = openDb();
  const clock = makeClock('2026-10-01T00:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-12T16:00:00.000Z');
  const leadId = acceptCreated(db, receipts, clock);
  for (const at of ['2026-10-12T20:59:59.999Z', '2026-10-12T21:00:00.000Z', '2026-10-13T15:59:59.999Z',
    '2026-10-13T16:00:00.000Z', '2026-10-13T21:00:00.000Z']) {
    clock.set(at);
    acceptDuplicate(db, receipts, leadId);
  }
  clock.set('2026-10-20T00:00:00.000Z');
  const day = (date, timezone) => receipts.journal({companyCode: 'alvi', from: date, to: date, timezone});

  const irk = day('2026-10-13', 'Asia/Irkutsk');
  assert.equal(irk.period.startUtc, '2026-10-12T16:00:00.000Z');
  assert.equal(irk.period.endUtcExclusive, '2026-10-13T16:00:00.000Z');
  assert.deepEqual(irk.knownReceiptCounts, {total: 4, created: 1, deduplicated: 3});
  assert.equal(irk.legacyLeadRowsCount, 1);

  const msk = day('2026-10-13', 'Europe/Moscow');
  assert.equal(msk.period.startUtc, '2026-10-12T21:00:00.000Z');
  assert.equal(msk.period.endUtcExclusive, '2026-10-13T21:00:00.000Z');
  assert.deepEqual(msk.knownReceiptCounts, {total: 3, created: 0, deduplicated: 3});
  assert.equal(msk.legacyLeadRowsCount, 0);
  assert.deepEqual(day('2026-10-12', 'Europe/Moscow').knownReceiptCounts, {total: 2, created: 1, deduplicated: 1});

  assert.deepEqual(day('2026-10-13', 'UTC').knownReceiptCounts, {total: 3, created: 0, deduplicated: 3});
  assert.deepEqual(day('2026-10-12', 'UTC').knownReceiptCounts, {total: 3, created: 1, deduplicated: 2});
  const range = receipts.journal({companyCode: 'alvi', from: '2026-10-12', to: '2026-10-14', timezone: 'Europe/Moscow'});
  assert.equal(range.knownReceiptCounts.total, 6);
  const bkk = day('2026-10-13', 'Asia/Bangkok');
  assert.equal(bkk.period.startUtc, '2026-10-12T17:00:00.000Z');
  assert.equal(bkk.period.endUtcExclusive, '2026-10-13T17:00:00.000Z');
  assert.deepEqual(bkk.knownReceiptCounts, {total: 4, created: 0, deduplicated: 4});
  assert.ok([msk, irk, range, bkk].every((result) => result.completeness === 'captured_since' && result.reasons.length === 0));
});

test('Лос-Анджелес через явный внутренний options.timezones: 25-часовые и 23-часовые сутки DST', () => {
  const db = openDb();
  const clock = makeClock('2026-10-01T00:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now, timezones: ['America/Los_Angeles', 'UTC']});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-11-01T06:59:59.999Z');
  const leadId = acceptCreated(db, receipts, clock);
  for (const at of ['2026-11-01T07:00:00.000Z', '2026-11-02T07:59:59.999Z', '2026-11-02T08:00:00.000Z']) {
    clock.set(at);
    acceptDuplicate(db, receipts, leadId);
  }
  clock.set('2026-11-10T00:00:00.000Z');
  const fallBack = receipts.journal({companyCode: 'alvi', from: '2026-11-01', to: '2026-11-01', timezone: 'America/Los_Angeles'});
  assert.equal(fallBack.period.startUtc, '2026-11-01T07:00:00.000Z');
  assert.equal(fallBack.period.endUtcExclusive, '2026-11-02T08:00:00.000Z');
  assert.deepEqual(fallBack.knownReceiptCounts, {total: 2, created: 0, deduplicated: 2});
  assert.equal(fallBack.completeness, 'captured_since');
  const spring = receipts.journal({companyCode: 'alvi', from: '2026-03-08', to: '2026-03-08', timezone: 'America/Los_Angeles'});
  assert.equal(spring.period.startUtc, '2026-03-08T08:00:00.000Z');
  assert.equal(spring.period.endUtcExclusive, '2026-03-09T07:00:00.000Z');
  assert.equal(spring.completeness, 'unknown');
  assert.equal(spring.knownReceiptCounts, null);
});

test('день активации, история до writer и открытый период не выдаются за полные', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T05:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  insertLead(db, {createdAt: '2026-10-13T05:00:00.000Z'});
  insertLead(db, {createdAt: '2026-10-12T05:00:00.000Z'});
  clock.set('2026-10-13T09:00:00.000Z');
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T10:00:00.000Z');
  acceptCreated(db, receipts, clock);

  clock.set('2026-10-14T12:00:00.000Z');
  const query = (date) => receipts.journal({companyCode: 'alvi', from: date, to: date, timezone: 'Europe/Moscow'});
  const activationDay = query('2026-10-13');
  assert.equal(activationDay.completeness, 'partial');
  assert.deepEqual(activationDay.reasons, ['period_starts_before_writer_activation']);
  assert.deepEqual(activationDay.knownReceiptCounts, {total: 1, created: 1, deduplicated: 0});
  assert.equal(activationDay.countsAreLowerBound, true);
  assert.equal(activationDay.writer.fullPeriodCovered, false);
  assert.equal(activationDay.writer.since, '2026-10-13T09:00:00.000Z');
  assert.equal(activationDay.legacyLeadRowsCount, 2, 'строки CRM отдельно от receipts');

  const before = query('2026-10-12');
  assert.equal(before.completeness, 'unknown');
  assert.deepEqual(before.reasons, ['period_starts_before_writer_activation', 'no_observed_receipt_window']);
  assert.equal(before.knownReceiptCounts, null);
  assert.equal(before.legacyLeadRowsCount, 1);

  const open = query('2026-10-14');
  assert.equal(open.completeness, 'partial');
  assert.deepEqual(open.reasons, ['period_not_closed']);
  assert.deepEqual(open.knownReceiptCounts, ZERO);
  assert.equal(open.countsAreLowerBound, true);

  const future = query('2026-10-20');
  assert.equal(future.completeness, 'unknown');
  assert.deepEqual(future.reasons, ['period_not_closed', 'no_observed_receipt_window']);
  assert.equal(future.knownReceiptCounts, null);

  clock.set('2026-10-14T21:00:00.000Z');
  const closedZero = query('2026-10-14');
  assert.equal(closedZero.completeness, 'captured_since');
  assert.deepEqual(closedZero.reasons, []);
  assert.deepEqual(closedZero.knownReceiptCounts, ZERO);
  assert.equal(closedZero.countsAreLowerBound, false);
  assert.equal(closedZero.writer.fullPeriodCovered, true);
  assert.equal(closedZero.writer.status, 'active');
});

test('активация ровно в локальную полночь покрывает эти сутки целиком', () => {
  const db = openDb();
  const clock = makeClock('2026-10-12T21:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T20:59:59.999Z');
  assert.equal(receipts.journal({companyCode: 'alvi', from: '2026-10-13', to: '2026-10-13', timezone: 'Europe/Moscow'}).completeness, 'partial');
  clock.set('2026-10-13T21:00:00.000Z');
  const result = receipts.journal({companyCode: 'alvi', from: '2026-10-13', to: '2026-10-13', timezone: 'Europe/Moscow'});
  assert.equal(result.completeness, 'captured_since');
  const irk = receipts.journal({companyCode: 'alvi', from: '2026-10-13', to: '2026-10-13', timezone: 'Asia/Irkutsk'});
  assert.equal(irk.completeness, 'partial');
  assert.deepEqual(irk.reasons, ['period_starts_before_writer_activation']);
});

test('непрерывный писатель + heartbeat: закрытый день — истинный ноль; reader только читает и не расширяет чужой интервал', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T00:00:00.000Z');
  const writer = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: uuidSource()});
  writer.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T12:00:00.000Z');
  writer.heartbeatWriter();
  clock.set('2026-10-14T00:00:30.000Z');
  writer.heartbeatWriter();
  clock.set('2026-10-14T01:00:00.000Z');

  const own = utcDay(writer, '2026-10-13');
  assert.equal(own.completeness, 'captured_since');
  assert.deepEqual(own.reasons, []);
  assert.deepEqual(own.knownReceiptCounts, ZERO);
  assert.equal(own.countsAreLowerBound, false);
  assert.equal(own.writer.fullPeriodCovered, true);
  assert.equal(own.writer.status, 'active');
  assert.equal(own.writer.currentSessionId, uuid(1));
  assert.deepEqual(own.writer.coveredIntervals, [{fromUtc: '2026-10-13T00:00:00.000Z', toUtc: '2026-10-14T00:00:00.000Z'}]);

  const reader = createRevenueLeadReceipts(db, {now: clock.now});
  const tables = ['revenue_lead_receipts', 'revenue_lead_receipt_writer', 'revenue_lead_writer_events', 'leads', 'lead_email_outbox'];
  const counts = () => tables.map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const countsBefore = counts();
  const changesBefore = db.prepare('SELECT total_changes() AS n').get().n;
  const read13 = utcDay(reader, '2026-10-13');
  assert.equal(read13.completeness, 'captured_since', 'сохранённый heartbeat после полуночи доказывает весь день');
  assert.equal(read13.writer.status, 'inactive');
  assert.equal(read13.writer.currentSessionId, null);
  const read14 = utcDay(reader, '2026-10-14');
  assert.deepEqual(read14.reasons, ['period_not_closed', 'writer_coverage_gap']);
  assert.deepEqual(read14.writer.coveredIntervals, [{fromUtc: '2026-10-14T00:00:00.000Z', toUtc: '2026-10-14T00:00:30.000Z'}]);
  assert.equal(read14.writer.lastConfirmedActiveAt, '2026-10-14T00:00:30.000Z');
  assert.deepEqual(counts(), countsBefore, 'reader не добавляет строк');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changesBefore);
  assert.throws(() => reader.heartbeatWriter(), {code: 'LEAD_RECEIPT_WRITER_INACTIVE'});
  assert.throws(() => reader.closeWriter(), {code: 'LEAD_RECEIPT_WRITER_INACTIVE'});

  const own14 = utcDay(writer, '2026-10-14');
  assert.deepEqual(own14.reasons, ['period_not_closed']);
  assert.deepEqual(own14.writer.coveredIntervals, [{fromUtc: '2026-10-14T00:00:00.000Z', toUtc: '2026-10-14T01:00:00.000Z'}]);
  assert.equal(own14.writer.lastConfirmedActiveAt, '2026-10-14T01:00:00.000Z');
});

test('штатный closeWriter до конца периода: день partial с writer_coverage_gap, а не ноль', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T00:00:00.000Z');
  const receipts = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: uuidSource()});
  receipts.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T12:00:00.000Z');
  receipts.heartbeatWriter();
  clock.set('2026-10-13T20:00:00.000Z');
  const closed = receipts.closeWriter();
  assert.deepEqual(closed, {sessionId: uuid(1), closedAt: '2026-10-13T20:00:00.000Z'});
  clock.set('2026-10-13T20:05:00.000Z');
  assert.deepEqual(receipts.closeWriter(), closed, 'повтор close идемпотентен');
  assert.throws(() => receipts.heartbeatWriter(), {code: 'LEAD_RECEIPT_WRITER_INACTIVE'});
  assert.throws(() => receipts.activateWriter({version: WRITER_VERSION}), {code: 'LEAD_RECEIPT_WRITER_STATE'});
  assert.throws(() => db.prepare(`INSERT INTO revenue_lead_writer_events (session_id, kind, version, occurred_at, occurred_ms)
    VALUES (?, 'heartbeat', 'lead-receipts/v1', '2026-10-13T23:00:00.000Z', ?)`).run(uuid(1), Date.parse('2026-10-13T23:00:00.000Z')),
  /append-only/, 'после close сессия не продлевается');

  clock.set('2026-10-15T00:00:00.000Z');
  const day = utcDay(receipts, '2026-10-13');
  assert.equal(day.completeness, 'partial');
  assert.deepEqual(day.reasons, ['writer_coverage_gap']);
  assert.deepEqual(day.knownReceiptCounts, ZERO);
  assert.equal(day.countsAreLowerBound, true);
  assert.equal(day.writer.fullPeriodCovered, false);
  assert.equal(day.writer.status, 'inactive');
  assert.deepEqual(day.writer.coveredIntervals, [{fromUtc: '2026-10-13T00:00:00.000Z', toUtc: '2026-10-13T20:00:00.000Z'}]);
  assert.equal(utcDay(receipts, '2026-10-14').completeness, 'unknown');
});

test('рестарт ровно в момент последнего heartbeat сливает эпохи; рестарт на 1 мс позже — разрыв без grace', () => {
  function scenario(restartAt) {
    const db = openDb();
    const clock = makeClock('2026-10-13T00:00:00.000Z');
    const ids = uuidSource();
    const first = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
    first.activateWriter({version: WRITER_VERSION});
    clock.set('2026-10-13T10:00:00.000Z');
    first.heartbeatWriter();
    // first падает без closeWriter; новый startup — новый экземпляр и новая сессия.
    clock.set(restartAt);
    const second = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
    assert.equal(second.activateWriter({version: WRITER_VERSION}).sessionId, uuid(2));
    clock.set('2026-10-14T00:00:00.000Z');
    second.heartbeatWriter();
    clock.set('2026-10-14T06:00:00.000Z');
    return utcDay(createRevenueLeadReceipts(db, {now: clock.now}), '2026-10-13');
  }
  const joined = scenario('2026-10-13T10:00:00.000Z');
  assert.equal(joined.completeness, 'captured_since');
  assert.deepEqual(joined.knownReceiptCounts, ZERO);
  assert.deepEqual(joined.writer.coveredIntervals, [{fromUtc: '2026-10-13T00:00:00.000Z', toUtc: '2026-10-14T00:00:00.000Z'}]);

  const gap = scenario('2026-10-13T10:00:00.001Z');
  assert.equal(gap.completeness, 'partial');
  assert.deepEqual(gap.reasons, ['writer_coverage_gap']);
  assert.equal(gap.countsAreLowerBound, true);
  assert.equal(gap.writer.coveredIntervals.length, 2);
});

test('упавший незакрытый экземпляр покрывает только до последнего heartbeat; новый startup не заполняет провал', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T00:00:00.000Z');
  const ids = uuidSource();
  const crashed = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
  crashed.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-13T14:00:00.000Z');
  acceptCreated(db, crashed, clock);
  clock.set('2026-10-13T15:00:00.000Z');
  crashed.heartbeatWriter();
  // Процесс упал: closeWriter не вызван, хвост после 15:00 не подтверждён.
  clock.set('2026-10-15T08:00:00.000Z');
  const next = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
  next.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-16T00:00:00.000Z');
  const reader = createRevenueLeadReceipts(db, {now: clock.now});

  const day13 = utcDay(reader, '2026-10-13');
  assert.equal(day13.completeness, 'partial');
  assert.deepEqual(day13.reasons, ['writer_coverage_gap']);
  assert.deepEqual(day13.knownReceiptCounts, {total: 1, created: 1, deduplicated: 0});
  assert.equal(day13.countsAreLowerBound, true);
  assert.deepEqual(day13.writer.coveredIntervals, [{fromUtc: '2026-10-13T00:00:00.000Z', toUtc: '2026-10-13T15:00:00.000Z'}]);

  const day14 = utcDay(reader, '2026-10-14');
  assert.equal(day14.completeness, 'unknown');
  assert.deepEqual(day14.reasons, ['writer_coverage_gap', 'no_observed_receipt_window']);
  assert.equal(day14.knownReceiptCounts, null);

  // Reader видит новую сессию только как момент start; сам next расширяет свой интервал до now.
  assert.equal(utcDay(reader, '2026-10-15').completeness, 'unknown');
  assert.equal(day13.writer.lastConfirmedActiveAt, '2026-10-15T08:00:00.000Z');
  const own15 = utcDay(next, '2026-10-15');
  assert.equal(own15.completeness, 'partial');
  assert.deepEqual(own15.reasons, ['writer_coverage_gap']);
  assert.deepEqual(own15.writer.coveredIntervals, [{fromUtc: '2026-10-15T08:00:00.000Z', toUtc: '2026-10-16T00:00:00.000Z'}]);
  const range = utcDay(next, '2026-10-13', '2026-10-15');
  assert.equal(range.completeness, 'partial');
  assert.equal(range.writer.coveredIntervals.length, 2);
});

test('старый stamp без сессий/hooks и откат кода после сессии не дают истинного нуля', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T09:00:00.000Z');
  const legacy = createRevenueLeadReceipts(db, {now: clock.now});
  // Так выглядела активация прежней версии модуля: один stamp, без runtime-сессий.
  db.prepare('INSERT INTO revenue_lead_receipt_writer (id, version, activated_at, activated_ms) VALUES (1, ?, ?, ?)')
    .run(WRITER_VERSION, '2026-10-13T09:00:00.000Z', Date.parse('2026-10-13T09:00:00.000Z'));
  clock.set('2026-10-13T10:00:00.000Z');
  const leadId = acceptCreated(db, legacy, clock);
  assert.equal(eventRows(db).length, 0);

  clock.set('2026-10-20T00:00:00.000Z');
  const fresh = createRevenueLeadReceipts(db, {now: clock.now});
  const day13 = utcDay(fresh, '2026-10-13');
  assert.equal(day13.completeness, 'unknown');
  assert.deepEqual(day13.reasons, ['period_starts_before_writer_activation', 'writer_coverage_gap', 'no_observed_receipt_window']);
  assert.deepEqual(day13.knownReceiptCounts, {total: 1, created: 1, deduplicated: 0});
  assert.equal(day13.countsAreLowerBound, true);
  assert.equal(day13.writer.status, 'inactive');
  assert.equal(day13.writer.since, '2026-10-13T09:00:00.000Z');
  assert.equal(day13.writer.lastConfirmedActiveAt, null);
  const day14 = utcDay(fresh, '2026-10-14');
  assert.equal(day14.completeness, 'unknown');
  assert.deepEqual(day14.reasons, ['writer_coverage_gap', 'no_observed_receipt_window']);
  assert.equal(day14.knownReceiptCounts, null);
  assert.equal(day14.writer.fullPeriodCovered, false);

  // Новая сборка с hooks работала 21.10 до 12:00, затем откат на код без heartbeat принимал формы.
  clock.set('2026-10-21T00:00:00.000Z');
  const upgraded = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: uuidSource()});
  assert.equal(upgraded.activateWriter({version: WRITER_VERSION}).activatedAt, '2026-10-13T09:00:00.000Z');
  clock.set('2026-10-21T12:00:00.000Z');
  upgraded.heartbeatWriter();
  clock.set('2026-10-22T10:00:00.000Z');
  const downgraded = createRevenueLeadReceipts(db, {now: clock.now});
  acceptDuplicate(db, downgraded, leadId);
  clock.set('2026-10-25T00:00:00.000Z');
  const reader = createRevenueLeadReceipts(db, {now: clock.now});
  const day21 = utcDay(reader, '2026-10-21');
  assert.equal(day21.completeness, 'partial');
  assert.deepEqual(day21.reasons, ['writer_coverage_gap']);
  const day22 = utcDay(reader, '2026-10-22');
  assert.equal(day22.completeness, 'unknown');
  assert.deepEqual(day22.knownReceiptCounts, {total: 1, created: 0, deduplicated: 1});
  assert.equal(day22.countsAreLowerBound, true);
  assert.equal(utcDay(reader, '2026-10-23').knownReceiptCounts, null);
});

test('откат часов: heartbeat отклоняется, форма принимается, будущий интервал обрезается, полнота не заявляется', () => {
  const db = openDb();
  const clock = makeClock('2026-10-13T00:00:00.000Z');
  const ids = uuidSource();
  const writer = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
  writer.activateWriter({version: WRITER_VERSION});
  clock.set('2026-10-15T00:00:00.000Z'); // скачок часов вперёд
  writer.heartbeatWriter();
  const leadId = acceptCreated(db, writer, clock);
  clock.set('2026-10-14T12:00:00.000Z'); // возврат назад
  assert.throws(() => writer.heartbeatWriter(), {code: 'LEAD_RECEIPT_CLOCK_REGRESSION'});
  const eventsBefore = eventRows(db);
  acceptDuplicate(db, writer, leadId);
  assert.deepEqual(eventRows(db), eventsBefore, 'heartbeat при откате не пишется, форма не отклонена');
  assert.equal(receiptRows(db).length, 2);

  const day13 = utcDay(writer, '2026-10-13');
  assert.equal(day13.completeness, 'partial');
  assert.deepEqual(day13.reasons, ['clock_regression']);
  assert.equal(day13.writer.fullPeriodCovered, false);
  const day14 = utcDay(writer, '2026-10-14');
  assert.deepEqual(day14.reasons, ['period_not_closed', 'clock_regression']);
  assert.deepEqual(day14.writer.coveredIntervals, [{fromUtc: '2026-10-14T00:00:00.000Z', toUtc: '2026-10-14T12:00:00.000Z'}]);
  assert.equal(day14.writer.lastConfirmedActiveAt, '2026-10-14T12:00:00.000Z', 'не будущее 15.10');

  const restarted = createRevenueLeadReceipts(db, {now: clock.now, randomUUID: ids});
  assert.throws(() => restarted.activateWriter({version: WRITER_VERSION}), {code: 'LEAD_RECEIPT_CLOCK_REGRESSION'});
  assert.equal(startCount(db), 1);

  clock.set('2026-10-20T00:00:00.000Z');
  const later = utcDay(createRevenueLeadReceipts(db, {now: clock.now}), '2026-10-14');
  assert.equal(later.completeness, 'partial', 'сохранённые receipts в обратном порядке времени остаются свидетельством');
  assert.deepEqual(later.reasons, ['clock_regression']);
  assert.equal(later.countsAreLowerBound, true);
});

test('после переоткрытия SQLite: новая сессия, провал 14.10 между эпохами не заполняется, второй receipt реальный', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenue-lead-receipts-'));
  const file = path.join(dir, 'crm.sqlite');
  try {
    const clock = makeClock('2026-10-13T09:00:00.000Z');
    const ids = uuidSource();
    let leadId;
    const first = openDb(file);
    try {
      const receipts = createRevenueLeadReceipts(first, {now: clock.now, randomUUID: ids});
      receipts.activateWriter({version: WRITER_VERSION});
      clock.set('2026-10-13T10:00:00.000Z');
      leadId = acceptCreated(first, receipts, clock);
    } finally {
      first.close();
    }
    const second = openDb(file);
    try {
      clock.set('2026-10-15T09:00:00.000Z');
      const receipts = createRevenueLeadReceipts(second, {now: clock.now, randomUUID: ids});
      assert.deepEqual(receipts.activateWriter({version: WRITER_VERSION}), {version: 'lead-receipts/v1',
        activatedAt: '2026-10-13T09:00:00.000Z', sessionId: uuid(2), sessionStartedAt: '2026-10-15T09:00:00.000Z'});
      clock.set('2026-10-15T10:00:00.000Z');
      acceptDuplicate(second, receipts, leadId);
      assert.deepEqual(receiptRows(second).map((row) => [row.outcome, row.received_at]), [
        ['created', '2026-10-13T10:00:00.000Z'],
        ['deduplicated', '2026-10-15T10:00:00.000Z'],
      ]);
      assert.deepEqual(eventRows(second), [
        [uuid(1), 'start', '2026-10-13T09:00:00.000Z'],
        [uuid(1), 'heartbeat', '2026-10-13T10:00:00.000Z'],
        [uuid(2), 'start', '2026-10-15T09:00:00.000Z'],
        [uuid(2), 'heartbeat', '2026-10-15T10:00:00.000Z'],
      ]);
      assert.throws(() => second.exec('DELETE FROM revenue_lead_receipts'), /append-only/);
      assert.throws(() => second.exec('DELETE FROM revenue_lead_writer_events'), /append-only/);
      clock.set('2026-10-20T00:00:00.000Z');
      const irk = (from, to = from) => receipts.journal({companyCode: 'alvi', from, to, timezone: 'Asia/Irkutsk'});
      const gapDay = irk('2026-10-14');
      assert.equal(gapDay.completeness, 'unknown');
      assert.deepEqual(gapDay.reasons, ['writer_coverage_gap', 'no_observed_receipt_window']);
      assert.equal(gapDay.knownReceiptCounts, null);
      assert.equal(gapDay.writer.fullPeriodCovered, false);
      const range = irk('2026-10-14', '2026-10-15');
      assert.equal(range.completeness, 'partial');
      assert.deepEqual(range.reasons, ['writer_coverage_gap']);
      assert.deepEqual(range.knownReceiptCounts, {total: 1, created: 0, deduplicated: 1});
      assert.equal(range.countsAreLowerBound, true);
      assert.deepEqual(range.writer.coveredIntervals, [{fromUtc: '2026-10-15T09:00:00.000Z', toUtc: '2026-10-15T16:00:00.000Z'}]);
      const covered = irk('2026-10-16');
      assert.equal(covered.completeness, 'captured_since');
      assert.deepEqual(covered.knownReceiptCounts, ZERO);
    } finally {
      second.close();
    }
  } finally {
    const absolute=path.resolve(dir),parent=path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute),parent);assert.match(path.basename(absolute),/^revenue-lead-receipts-[A-Za-z0-9]+$/);
    assert.equal(fs.lstatSync(absolute).isSymbolicLink(),false);
    fs.rmSync(absolute, {recursive: true, force: true});
  }
});
