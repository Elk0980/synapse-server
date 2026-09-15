'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createEmailDiagnostics} = require('./email-diagnostics');
const {createEmailOutbox} = require('./email-outbox');
const {createEmailNotifications} = require('./email-notifications');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, company_code TEXT, name TEXT, contact TEXT)');
  createEmailOutbox(db, {notifyLead() { assert.fail('diagnostics must not send mail'); }});
  const lead = db.prepare('INSERT INTO leads VALUES (?, ?, ?, ?)');
  const queued = db.prepare(`INSERT INTO lead_email_outbox
    (lead_id,status,attempts,created_at,next_attempt_at,last_attempt_at,last_error_code,sent_at)
    VALUES (?, ?, 7, '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z', ?, NULL)`);
  return {db, add(id, company, status, error = null) {
    lead.run(id, company, 'SENTINEL_PRIVATE_NAME', 'SENTINEL_PRIVATE_CONTACT');
    queued.run(id, status, error);
  }};
}

test('only company aggregates and allowlisted errors leave a read-only database', () => {
  const f = fixture();
  try {
    f.add(1, 'ALVI', 'pending', 'SMTP_AUTH'); f.add(2, 'alvi', 'pending', 'SMTP_AUTH');
    f.add(3, 'alvi', 'sending'); f.add(4, 'alvi', 'sent');
    f.add(5, 'avokado', 'pending', 'EMAIL_RECIPIENT_MISSING');
    f.add(6, 'AVOKADO', 'pending', 'SENTINEL_PRIVATE_SERVER_ERROR');
    f.add(7, 'other', 'pending', 'SMTP_AUTH');
    f.add(8, null, 'sent');
    const environment = Object.freeze({LEADS_SMTP_HOST: 'SENTINEL_HOST', LEADS_SMTP_PORT: '465',
      LEADS_SMTP_USER: 'SENTINEL_USER', LEADS_SMTP_PASSWORD: 'SENTINEL_PASSWORD', LEADS_MAIL_FROM: 'SENTINEL_FROM',
      LEADS_NOTIFY_EMAIL_ALVI: 'SENTINEL_RECIPIENT_ALVI', LEADS_NOTIFY_EMAIL_AVOKADO: 'SENTINEL_RECIPIENT_AVOKADO'});
    const before = JSON.stringify(f.db.prepare('SELECT * FROM lead_email_outbox ORDER BY lead_id').all());
    f.db.exec('PRAGMA query_only = ON');
    const diagnostics = createEmailDiagnostics(f.db, {environment, now: () => Date.parse('2026-09-15T12:00:00Z')});
    const result = diagnostics.getStatus();
    assert.deepEqual(result, {checkedAt: '2026-09-15T12:00:00.000Z',
      smtp: {host: true, port: true, user: true, password: true, from: true, configured: true},
      companies: [
        {code: 'alvi', recipientConfigured: true, queued: 2, sending: 1, sent: 1, errors: [{code: 'SMTP_AUTH', count: 2}]},
        {code: 'avokado', recipientConfigured: true, queued: 2, sending: 0, sent: 0,
          errors: [{code: 'EMAIL_RECIPIENT_MISSING', count: 1}, {code: 'SMTP_SEND_FAILED', count: 1}]}
      ]});
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL|lead_id|attempts|contact|recipient@/);
    assert.deepEqual(diagnostics.getStatus(), result);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM lead_email_outbox ORDER BY lead_id').all()), before);
    assert.equal(environment.LEADS_SMTP_PASSWORD, 'SENTINEL_PASSWORD');
  } finally { f.db.close(); }
});

test('SMTP flags match effective defaults, blank settings, sender fallback and port validation', () => {
  const f = fixture();
  try {
    for (const environment of [{}, {LEADS_SMTP_HOST: ' '}, {LEADS_SMTP_USER: 'user'},
      {LEADS_SMTP_USER: 'user', LEADS_SMTP_PASSWORD: 'password'},
      {LEADS_SMTP_USER: 'user', LEADS_SMTP_PASSWORD: 'password', LEADS_SMTP_PORT: '587', LEADS_MAIL_FROM: ' '},
      {LEADS_SMTP_USER: 'user', LEADS_SMTP_PASSWORD: 'password', LEADS_SMTP_PORT: '465suffix'},
      {LEADS_SMTP_USER: 'user', LEADS_SMTP_PASSWORD: 'password', LEADS_SMTP_PORT: '65536'},
      {LEADS_SMTP_USER: 'user', LEADS_SMTP_PASSWORD: 'password', LEADS_SMTP_PORT: ''},
      {LEADS_SMTP_USER: ' ', LEADS_SMTP_PASSWORD: 'password', LEADS_MAIL_FROM: 'sender'}]) {
      const status = createEmailDiagnostics(f.db, {environment}).getStatus();
      let enabled;
      try {
        enabled = createEmailNotifications(environment, {info() {}}, () => ({
          sendMail() { assert.fail('must not send'); }, verify() { assert.fail('must not connect'); }
        })).enabled;
      } catch { enabled = false; }
      assert.equal(status.smtp.configured, enabled, JSON.stringify(environment));
      assert.ok(Object.values(status.smtp).every(value => typeof value === 'boolean'));
    }
    assert.deepEqual(createEmailDiagnostics(f.db, {environment: {}}).getStatus().smtp,
      {host: true, port: true, user: false, password: false, from: false, configured: false});
    const fallback = createEmailDiagnostics(f.db, {environment: {LEADS_SMTP_USER: 'user', LEADS_SMTP_PASSWORD: 'password'}}).getStatus();
    assert.equal(fallback.smtp.from, true);
    const explicitSender = createEmailDiagnostics(f.db, {environment: {LEADS_MAIL_FROM: 'sender'}}).getStatus();
    assert.equal(explicitSender.smtp.from, true);
    assert.equal(explicitSender.smtp.configured, false);
  } finally { f.db.close(); }
});

test('company recipients never fall back to the generic recipient and empty queues have stable shape', () => {
  const f = fixture();
  try {
    const result = createEmailDiagnostics(f.db, {environment: {LEADS_NOTIFY_EMAIL: 'SENTINEL_GENERIC',
      LEADS_NOTIFY_EMAIL_ALVI: '  ', LEADS_NOTIFY_EMAIL_AVOKADO: 'SENTINEL_AVOKADO'}}).getStatus();
    assert.deepEqual(result.companies, [
      {code: 'alvi', recipientConfigured: false, queued: 0, sending: 0, sent: 0, errors: []},
      {code: 'avokado', recipientConfigured: true, queued: 0, sending: 0, sent: 0, errors: []}
    ]);
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
  } finally { f.db.close(); }
});
