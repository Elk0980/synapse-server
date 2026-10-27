'use strict';

// AVOCADO-MULTI-RECIPIENT-20261027: several recipients of one company, per-address acceptance,
// retry of the remaining addresses only. Only example.test addresses and a fake SMTP transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {createEmailSettings} = require('./email-settings');
const {createEmailOutbox, RETRY_DELAYS, LEASE_MS} = require('./email-outbox');
const {createEmailDiagnostics} = require('./email-diagnostics');
const {createEmailSendLimit} = require('./email-send-limit');
const {createEmailNotifications} = require('./email-notifications');
const {parseRecipientList, normalizeRecipientList, MAX_RECIPIENTS} = require('./email-recipients');

const apiKey = 'fixture-key-not-a-live-credential';
const sender = {provider: 'mailru', user: 'sender@example.test', password: 'SENTINEL_PASSWORD'};
const A = 'owner@example.test', B = 'admin@example.test', C = 'third@example.test';

// Fake SMTP: one entry per sendMail; behaviour per address is scripted by the test.
function fakeSmtp() {
  const sent = [], constructed = [], script = new Map();
  const createTransport = options => {
    constructed.push(options);
    return {
      async verify() { return true; },
      sendMail(message) {
        sent.push(message);
        const step = script.get(message.to);
        if (typeof step === 'function') return step(message);
        if (step === 'reject') return Promise.resolve({accepted: [], rejected: [message.to]});
        if (step === 'timeout') return Promise.reject(Object.assign(new Error('SENTINEL ' + message.to), {code: 'ETIMEDOUT'}));
        if (step === 'auth') return Promise.reject(Object.assign(new Error('SENTINEL_PASSWORD ' + message.to), {code: 'EAUTH'}));
        return Promise.resolve({accepted: [message.to], rejected: []});
      },
    };
  };
  return {sent, constructed, script, createTransport, to: address => sent.filter(message => message.to === address).length};
}

function fixture(t, {environment = {}, dailyCap, limited = false} = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE leads (id INTEGER PRIMARY KEY, name TEXT, contact TEXT, company_code TEXT, created_at TEXT);`);
  t.after(() => db.close());
  let time = Date.parse('2026-10-27T03:00:00Z');
  const smtp = fakeSmtp(), logs = [];
  const now = () => time;
  const settings = () => createEmailSettings(db, {apiKey, environment, createTransport: smtp.createTransport, now});
  const store = settings();
  const limit = limited ? createEmailSendLimit(db, {now, dailyCap: dailyCap || 100}) : null;
  const outbox = (notifications = store.notifications) => createEmailOutbox(db, notifications, {now,
    logger: {warn: line => logs.push(line)}, acquireSlot: limit ? () => limit.acquire().ok : () => true});
  const lead = (id, company = 'avokado') => {
    db.prepare('INSERT INTO leads VALUES (?,?,?,?,?)').run(id, 'Fixture', 'fixture@example.test', company, '2026-10-27T03:00:00Z');
    return {id};
  };
  const job = id => db.prepare('SELECT * FROM lead_email_outbox WHERE lead_id = ?').get(id);
  const recipients = id => Object.fromEntries(db.prepare('SELECT recipient, status, attempts FROM lead_email_recipients WHERE lead_id = ?')
    .all(id).map(row => [row.recipient, row.status]));
  return {db, smtp, logs, store, settings, outbox, lead, job, recipients, limit, advance: ms => { time += ms; }};
}

test('the list format: normalization, safe de-duplication and whole-value rejection', () => {
  assert.deepEqual(parseRecipientList('  owner@Example.TEST ,admin@example.test  '), [A, B]);
  assert.deepEqual(parseRecipientList(`${A}, owner@EXAMPLE.test, ${B}`), [A, B], 'same mailbox with a differently cased domain is kept once');
  assert.deepEqual(parseRecipientList(`Owner@example.test, ${A}`), ['Owner@example.test', A], 'local parts can differ by case and are both kept');
  assert.equal(normalizeRecipientList(''), '');
  assert.equal(normalizeRecipientList('   '), '');
  assert.equal(normalizeRecipientList(A), A, 'one address keeps the previous single meaning');
  assert.equal(MAX_RECIPIENTS, 5);
  const five = Array.from({length: 5}, (_, i) => `r${i}@example.test`).join(',');
  assert.equal(parseRecipientList(five).length, 5);
  for (const value of [five + ',r5@example.test', `${A},,${B}`, `${A},`, `${A};${B}`, `Owner <${A}>`, `${A}\r\nBcc: x@example.test`,
    `${A}\n`, `${A}\u0000`, `${A}, not-an-address`, 'x'.repeat(1025), [A], 7, null, undefined, {recipient: A}]) {
    assert.throws(() => parseRecipientList(value), error => error.status === 400, JSON.stringify(value));
  }
});

test('company recipients: atomic save, isolation, sender secret untouched, no SMTP; full list after restart', t => {
  const f = fixture(t, {environment: {LEADS_NOTIFY_EMAIL: 'generic@example.test'}});
  f.store.save({...sender, alviRecipient: 'alvi@example.test', avokadoRecipient: A});
  const envelope = () => f.db.prepare('SELECT * FROM email_settings').get();
  const before = {...envelope()};
  const saved = f.store.saveCompany('avokado', {recipient: ` ${A} , ${B} `});
  assert.equal(saved.recipient, `${A}, ${B}`);
  assert.deepEqual(saved.recipients, [A, B]);
  assert.equal(saved.recipientLimit, 5);
  for (const body of [{recipient: `${A}, bad`}, {recipient: `${A}\r\nBcc: x@example.test`}, {recipient: [A, B]},
    {recipient: 'r1@example.test,r2@example.test,r3@example.test,r4@example.test,r5@example.test,r6@example.test'},
    {recipient: A, extra: 'x'}, {}, null]) {
    assert.throws(() => f.store.saveCompany('avokado', body), error => error.status === 400);
    assert.equal(f.store.getCompany('avokado').recipient, `${A}, ${B}`, 'an invalid value saves nothing');
  }
  assert.deepEqual({...envelope()}, before, 'recipient changes do not touch the encrypted sender envelope');
  assert.equal(f.store.getCompany('alvi').recipient, 'alvi@example.test');
  assert.equal(f.store.getCompany('palitra-love').recipient, '', 'an unrelated company never inherits the generic address');
  assert.equal(f.store.getEnvironment().LEADS_SMTP_PASSWORD, sender.password);
  f.db.exec("CREATE TRIGGER fail_recipients BEFORE UPDATE ON company_email_recipients BEGIN SELECT RAISE(ABORT, 'SENTINEL_DB'); END");
  assert.throws(() => f.store.saveCompany('avokado', {recipient: C}), error => error.status === 500 && !/SENTINEL/.test(error.message));
  f.db.exec('DROP TRIGGER fail_recipients');
  assert.equal(f.store.getCompany('avokado').recipient, `${A}, ${B}`);
  const reopened = f.settings();
  assert.deepEqual(reopened.getCompany('avokado').recipients, [A, B]);
  assert.equal(reopened.getPublic().avokadoRecipient, `${A}, ${B}`);
  f.store.saveCompany('avokado', {recipient: ''});
  assert.deepEqual(f.store.getCompany('avokado').recipients, [], 'empty value disables the company');
  assert.deepEqual(f.smtp.constructed, [], 'GET/PUT never construct SMTP');
});

test('sender saves keep lists in the company table and a rollback-safe single address in the envelope', t => {
  const f = fixture(t, {environment: {LEADS_NOTIFY_EMAIL_AVOKADO: `${A}, ${B}`}});
  // First cabinet save with a list that so far came from the environment: the list is kept.
  f.store.save({provider: sender.provider, user: sender.user, password: sender.password});
  assert.deepEqual(f.store.getCompany('avokado').recipients, [A, B]);
  // Legacy full save with an explicit list (old API shape) updates the company list.
  f.store.save({...sender, password: '', alviRecipient: 'alvi@example.test', avokadoRecipient: `${C}, ${A}`});
  assert.deepEqual(f.store.getCompany('avokado').recipients, [C, A]);
  assert.equal(f.store.getCompany('alvi').recipient, 'alvi@example.test');
  // Independent check of the stored v1 envelope with the previous single-address rules.
  const row = f.db.prepare('SELECT encrypted_json FROM email_settings').get();
  const envelope = JSON.parse(row.encrypted_json);
  const purpose = Buffer.from('synapse/crm/email-settings/v1');
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), Buffer.from(envelope.salt, 'base64'), purpose, 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(purpose); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  assert.equal(envelope.version, 1);
  for (const key of ['alviRecipient', 'avokadoRecipient']) assert.doesNotMatch(plain[key], /,/, 'no list inside the envelope');
  assert.equal(plain.avokadoRecipient, C);
  // A failed database write leaves both the envelope and the lists unchanged.
  const before = f.db.prepare('SELECT * FROM email_settings').get();
  f.db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON email_settings BEGIN SELECT RAISE(ABORT, 'SENTINEL'); END");
  assert.throws(() => f.store.save({...sender, alviRecipient: `${A}, ${B}`, avokadoRecipient: B}), error => error.status === 500);
  assert.deepEqual(f.db.prepare('SELECT * FROM email_settings').get(), before);
  assert.deepEqual(f.store.getCompany('alvi').recipients, ['alvi@example.test']);
  assert.deepEqual(f.store.getCompany('avokado').recipients, [C, A]);
  assert.deepEqual(f.smtp.sent, []);
});

test('a v1 envelope written by the previous single-recipient build is read unchanged; tampering stays fail-closed', t => {
  const f = fixture(t);
  const purpose = Buffer.from('synapse/crm/email-settings/v1');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), salt, purpose, 32));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(purpose);
  const config = {provider: 'yandex', user: sender.user, password: 'OLD_SENTINEL', alviRecipient: 'alvi@example.test', avokadoRecipient: A};
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  const legacy = JSON.stringify({version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')});
  f.db.prepare("INSERT INTO email_settings VALUES (1, 3, ?, '2026-09-01T00:00:00Z')").run(legacy);
  const store = f.settings();
  assert.deepEqual(store.getCompany('avokado').recipients, [A]);
  assert.equal(store.getPublic().needsPassword, false);
  assert.equal(store.getEnvironment().LEADS_SMTP_PASSWORD, 'OLD_SENTINEL');
  const broken = JSON.parse(legacy); broken.tag = Buffer.alloc(16).toString('base64');
  f.db.prepare('UPDATE email_settings SET encrypted_json = ?').run(JSON.stringify(broken));
  assert.equal(f.settings().getPublic().needsPassword, true);
  assert.equal(f.settings().getEnvironment().LEADS_SMTP_PASSWORD, '');
});

test('two recipients receive separate messages; the job is sent only after both are accepted', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  const queue = f.outbox();
  queue.enqueue(f.lead(1));
  await queue.drain();
  assert.deepEqual(f.smtp.sent.map(message => message.to), [A, B], 'one message per address, never a shared To list');
  assert.ok(f.smtp.sent.every(message => message.messageId === '<synapse-lead-1@synapsebusiness.ru>' && message.from === sender.user));
  assert.equal(f.job(1).status, 'sent');
  assert.deepEqual(f.recipients(1), {[A]: 'accepted', [B]: 'accepted'});
  queue.enqueue({id: 1}, {repeated: true});
  await queue.drain();
  assert.equal(f.smtp.sent.length, 2, 'a repeated form never resends a delivered notification');
});

test('partial acceptance survives restart; only the remaining address is retried', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  f.smtp.script.set(B, 'reject');
  const first = f.outbox();
  first.enqueue(f.lead(1));
  await first.drain();
  assert.equal(f.job(1).status, 'pending', 'a partly accepted notification is not marked sent');
  assert.equal(f.job(1).last_error_code, 'EMAIL_RECIPIENT_REJECTED');
  assert.deepEqual(f.recipients(1), {[A]: 'accepted', [B]: 'pending'});
  await first.stop();
  f.smtp.script.delete(B);
  const restarted = f.outbox();
  await restarted.drain();
  assert.equal(f.smtp.to(B), 1, 'backoff is respected after restart');
  f.advance(RETRY_DELAYS[0]);
  await restarted.drain();
  assert.equal(f.smtp.to(A), 1, 'the accepted address is never repeated');
  assert.equal(f.smtp.to(B), 2);
  assert.equal(f.job(1).status, 'sent');
  assert.ok(f.logs.every(line => !/@|SENTINEL/.test(line)), 'logs keep only safe categories');
});

test('timeouts are neither delivery nor proven non-delivery; job-level failures stop the claim', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  f.smtp.script.set(A, 'timeout');
  const queue = f.outbox();
  queue.enqueue(f.lead(1));
  await queue.drain();
  assert.deepEqual(f.smtp.sent.map(message => message.to), [A], 'a connection failure does not continue to the next address');
  assert.equal(f.job(1).status, 'pending');
  assert.equal(f.job(1).last_error_code, 'SMTP_CONNECTION');
  assert.deepEqual(f.recipients(1), {[A]: 'pending', [B]: 'pending'});
  f.smtp.script.delete(A);
  f.advance(RETRY_DELAYS[0]);
  await queue.drain();
  // B was never tried and goes first; A is retried (SMTP is at-least-once, not exactly-once).
  assert.deepEqual(f.smtp.sent.map(message => message.to), [A, B, A]);
  assert.equal(f.job(1).status, 'sent');
  const stored = JSON.stringify(f.db.prepare('SELECT * FROM lead_email_recipients').all()) + JSON.stringify(f.job(1));
  assert.doesNotMatch(stored, /SENTINEL/);
});

test('a superseded worker cannot repeat a known accepted address or overwrite the current result', async t => {
  for (const staleFinishes of ['success', 'failure']) {
    const f = fixture(t);
    f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
    let releaseStale;
    f.smtp.script.set(B, () => new Promise((resolve, reject) => { releaseStale = {resolve, reject}; }));
    const stale = f.outbox(), fresh = f.outbox();
    stale.enqueue(f.lead(1));
    const staleRun = stale.drain();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.smtp.sent.map(message => message.to), [A, B], 'the stale worker has sent A and hangs on B');
    await fresh.drain();
    assert.equal(f.smtp.sent.length, 2, 'a live lease cannot be taken');
    f.advance(LEASE_MS + 1);
    f.smtp.script.delete(B);
    await fresh.drain();
    assert.deepEqual(f.smtp.sent.map(message => message.to), [A, B, B], 'the new worker skips the accepted A');
    assert.equal(f.job(1).status, 'sent');
    if (staleFinishes === 'success') releaseStale.resolve({accepted: [B]});
    else releaseStale.reject(Object.assign(new Error('synthetic'), {code: 'ETIMEDOUT'}));
    await staleRun;
    assert.equal(f.job(1).status, 'sent', 'stale completion cannot reopen or rewrite the job');
    assert.equal(f.job(1).last_error_code, null);
    assert.deepEqual(f.recipients(1), {[A]: 'accepted', [B]: 'accepted'});
    assert.equal(f.smtp.to(A), 1);
    assert.equal(f.logs.length, 0, 'a stale failure is not logged as pending');
  }
});

test('an address recorded as accepted by another worker during this claim is not sent again', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${B}, ${A}`});
  // While this worker talks to B, another process records A as accepted (as its own SMTP reported).
  f.smtp.script.set(B, async message => {
    f.db.prepare("UPDATE lead_email_recipients SET status = 'accepted', accepted_at = 'x' WHERE lead_id = 1 AND recipient = ?").run(A);
    return {accepted: [message.to]};
  });
  const queue = f.outbox();
  queue.enqueue(f.lead(1));
  await queue.drain();
  assert.deepEqual(f.smtp.sent.map(message => message.to), [B]);
  assert.equal(f.job(1).status, 'sent');
});

test('frozen snapshot: settings changes never add addresses after an acceptance; removed addresses are withdrawn', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  f.smtp.script.set(B, 'reject');
  const queue = f.outbox();
  queue.enqueue(f.lead(1)); queue.enqueue(f.lead(2));
  await queue.drain();
  assert.deepEqual(f.recipients(1), {[A]: 'accepted', [B]: 'pending'});
  f.smtp.script.delete(B);
  f.store.saveCompany('avokado', {recipient: `${A}, ${B}, ${C}`});
  f.advance(RETRY_DELAYS[0]);
  await queue.drain();
  assert.equal(f.smtp.to(C), 0, 'a newly added address never receives older partly delivered leads');
  assert.equal(f.job(1).status, 'sent');
  // Lead 3: A accepted, B pending; then B is removed from the settings.
  f.smtp.script.set(B, 'reject');
  queue.enqueue(f.lead(3));
  await queue.drain();
  assert.deepEqual(f.recipients(3), {[A]: 'accepted', [B]: 'pending', [C]: 'accepted'});
  const before = f.smtp.sent.length;
  f.store.saveCompany('avokado', {recipient: `${A}, ${C}`});
  f.advance(RETRY_DELAYS[0]);
  await queue.drain();
  assert.equal(f.smtp.sent.length, before, 'a removed address receives nothing');
  assert.deepEqual(f.recipients(3), {[A]: 'accepted', [B]: 'withdrawn', [C]: 'accepted'});
  assert.equal(f.job(3).status, 'sent');
});

test('before any acceptance a pending job follows corrected settings, like the previous single recipient', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: 'typo@example.test'});
  f.smtp.script.set('typo@example.test', 'reject');
  const queue = f.outbox();
  queue.enqueue(f.lead(1));
  await queue.drain();
  assert.equal(f.job(1).last_error_code, 'EMAIL_RECIPIENT_REJECTED');
  f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  f.advance(RETRY_DELAYS[0]);
  await queue.drain();
  assert.deepEqual(f.smtp.sent.map(message => message.to), ['typo@example.test', A, B]);
  assert.equal(f.job(1).status, 'sent');
  assert.deepEqual(f.recipients(1), {[A]: 'accepted', [B]: 'accepted'});
});

test('empty, missing and invalid configuration never sends and never falls back to another company', async t => {
  const f = fixture(t, {environment: {LEADS_NOTIFY_EMAIL: 'generic@example.test'}});
  f.store.save(sender);
  f.store.saveCompany('avokado', {recipient: ''});
  const queue = f.outbox();
  queue.enqueue(f.lead(1)); queue.enqueue(f.lead(2, 'palitra-love'));
  await queue.drain();
  assert.deepEqual(f.smtp.sent, []);
  for (const id of [1, 2]) {
    assert.equal(f.job(id).status, 'pending');
    assert.equal(f.job(id).last_error_code, 'EMAIL_RECIPIENT_MISSING');
  }
  // The notifier itself refuses an address that is not configured for the company.
  await assert.rejects(f.store.notifications.notifyLead({company_code: 'avokado', name: 'x', created_at: '2026-10-27T00:00:00Z'},
    {recipient: A}), {code: 'EMAIL_RECIPIENT_MISSING'});
  assert.deepEqual(f.smtp.sent, []);
});

test('legacy jobs: sent rows are preserved byte for byte; old pending and expired sending rows still deliver', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: A});
  f.lead(1); f.lead(2); f.lead(3);
  // Rows as written by the previous build, before lead_email_recipients existed.
  f.db.exec(`CREATE TABLE lead_email_outbox (lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent')), attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL, last_attempt_at TEXT, last_error_code TEXT, sent_at TEXT, repeated_at TEXT);
    INSERT INTO lead_email_outbox VALUES (1,'sent',1,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-01T00:00:01Z',NULL,'2026-10-01T00:00:02Z',NULL);
    INSERT INTO lead_email_outbox VALUES (2,'pending',2,'2026-10-02T00:00:00Z','2026-10-02T00:10:00Z','2026-10-02T00:00:00Z','SMTP_AUTH',NULL,NULL);
    INSERT INTO lead_email_outbox VALUES (3,'sending',1,'2026-10-03T00:00:00Z','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z',NULL,NULL,NULL);`);
  const legacySent = JSON.stringify(f.job(1));
  f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  const queue = f.outbox();
  createEmailOutbox(f.db, f.store.notifications); // a second migration run is a no-op
  queue.enqueue({id: 1}, {repeated: true});
  await queue.drain();
  assert.equal(JSON.stringify(f.job(1)), legacySent, 'a delivered legacy job is never resent or rewritten');
  assert.deepEqual(f.recipients(1), {});
  for (const id of [2, 3]) {
    assert.equal(f.job(id).status, 'sent');
    assert.deepEqual(f.recipients(id), {[A]: 'accepted', [B]: 'accepted'});
  }
  assert.equal(f.smtp.sent.length, 4);
});

test('the shared rate limiter counts each SMTP message; a refusal is not an attempt and keeps no lease', async t => {
  const f = fixture(t, {limited: true, dailyCap: 3});
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  const queue = f.outbox();
  queue.enqueue(f.lead(1)); queue.enqueue(f.lead(2));
  await queue.drain();
  assert.deepEqual(f.smtp.sent.map(message => message.to), [A], 'the second address waits for the 2 s interval');
  assert.equal(f.job(1).status, 'pending');
  assert.equal(f.job(1).last_error_code, null, 'a quota refusal is not a delivery error');
  assert.equal(f.job(1).attempts, 1);
  assert.equal(f.job(2).attempts, 0, 'a refused job is not claimed');
  const slots = () => f.db.prepare('SELECT COUNT(*) n FROM email_send_slots').get().n;
  assert.equal(slots(), 1);
  f.advance(2000); await queue.drain();
  f.advance(2000); await queue.drain();
  f.advance(2000); await queue.drain();
  assert.deepEqual(f.smtp.sent.map(message => message.to), [A, B, A], 'the daily cap of 3 SMTP messages is not exceeded');
  assert.equal(slots(), 3);
  assert.equal(f.job(1).status, 'sent');
  assert.equal(f.job(2).status, 'pending');
  assert.deepEqual(f.recipients(2), {[A]: 'accepted', [B]: 'pending'});
  f.advance(86400000); await queue.drain();
  assert.equal(f.job(2).status, 'sent');
  assert.equal(f.smtp.to(A), 2);
});

test('diagnostics count a partly accepted notification as waiting, not as sent', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  f.smtp.script.set(B, 'reject');
  const queue = f.outbox();
  queue.enqueue(f.lead(1));
  await queue.drain();
  const status = createEmailDiagnostics(f.db, {getEnvironment: f.store.getEnvironment}).getStatus('avokado');
  assert.deepEqual(status.companies, [{code: 'avokado', recipientConfigured: true, queued: 1, sending: 0, sent: 0,
    errors: [{code: 'EMAIL_RECIPIENT_REJECTED', count: 1}]}]);
  assert.doesNotMatch(JSON.stringify(status), /@/);
});

test('notifier: recipients() never opens SMTP; a single legacy call keeps its previous message shape', async () => {
  const sent = [], constructed = [];
  const notifier = createEmailNotifications({LEADS_SMTP_USER: sender.user, LEADS_SMTP_PASSWORD: 'x',
    LEADS_NOTIFY_EMAIL_AVOKADO: A}, {info() {}}, options => { constructed.push(options); return {sendMail: async message => { sent.push(message); return {accepted: [message.to]}; }}; });
  assert.deepEqual(notifier.recipients({company_code: 'AVOKADO'}), [A]);
  assert.deepEqual(notifier.recipients({company_code: 'other'}), []);
  assert.equal(sent.length, 0);
  await notifier.notifyLead({company_code: 'avokado', name: 'x', created_at: '2026-10-27T00:00:00Z'});
  assert.equal(sent[0].to, A);
  await assert.rejects(notifier.notifyLead({company_code: 'avokado', name: 'x', created_at: '2026-10-27T00:00:00Z'}, {recipient: C}),
    {code: 'EMAIL_RECIPIENT_MISSING'}, 'an address outside the configured list is never used');
  await assert.rejects(notifier.notifyLead({company_code: 'alvi', name: 'x', created_at: '2026-10-27T00:00:00Z'}, {recipient: A}),
    {code: 'EMAIL_RECIPIENT_MISSING'}, 'another company address is never used');
  assert.equal(sent.length, 1);
  const disabled = createEmailNotifications({LEADS_NOTIFY_EMAIL_AVOKADO: `${A}, ${B}`}, {info() {}}, () => assert.fail('no SMTP'));
  assert.deepEqual(disabled.recipients({company_code: 'avokado'}), [A, B]);
});

// R2: delivery requires a positive SMTP acknowledgement of exactly the requested address.
const UNCONFIRMED_ACKS = [
  ['undefined', undefined], ['null', null], ['empty object', {}], ['accepted undefined', {accepted: undefined, response: '250 SENTINEL_RAW'}],
  ['number', 1], ['accepted as a string', {accepted: A}], ['wrong address', {accepted: ['other@example.test'], rejected: [A], response: 'SENTINEL_RAW'}],
  ['malformed entries', {accepted: [null, 7, {name: 'x'}, '']}], ['local part with another case', {accepted: ['OWNER@example.test']}],
  ['header injection in the ACK', {accepted: [`${A}\r\nBcc: x@example.test`]}],
];
const CONFIRMED_ACKS = [
  ['exact address', {accepted: [A]}], ['domain in another case', {accepted: ['owner@EXAMPLE.TEST']}],
  ['address object', {accepted: [{address: A, name: 'Owner'}]}], ['display form', {accepted: [`Owner <${A}>`]}],
  ['with other entries', {accepted: ['other@example.test', A], rejected: []}],
];
const directNotifier = (environment, ack) => {
  const sent = [];
  const notifier = createEmailNotifications({LEADS_SMTP_USER: sender.user, LEADS_SMTP_PASSWORD: 'x', ...environment}, {info() {}},
    () => ({sendMail: async message => { sent.push(message); return typeof ack === 'function' ? ack(message) : ack; }}));
  return {notifier, sent};
};
const avokadoLead = {company_code: 'avokado', name: 'x', created_at: '2026-10-27T00:00:00Z'};

test('direct single-address notify: only a positive ACK of that address is a success', async () => {
  for (const [label, ack] of UNCONFIRMED_ACKS) {
    const {notifier} = directNotifier({LEADS_NOTIFY_EMAIL_AVOKADO: `${A}, ${B}`}, ack);
    await assert.rejects(notifier.notifyLead(avokadoLead, {recipient: A}), error => {
      assert.equal(error.code, 'EMAIL_DELIVERY_UNCONFIRMED', label);
      assert.doesNotMatch(error.message, /@|SENTINEL/, label);
      return true;
    });
  }
  const refused = directNotifier({LEADS_NOTIFY_EMAIL_AVOKADO: A}, {accepted: [], rejected: [A]});
  await assert.rejects(refused.notifier.notifyLead(avokadoLead, {recipient: A}), {code: 'EMAIL_RECIPIENT_REJECTED'});
  for (const [label, ack] of CONFIRMED_ACKS) {
    const {notifier, sent} = directNotifier({LEADS_NOTIFY_EMAIL_AVOKADO: `${A}, ${B}`}, ack);
    assert.equal(await notifier.notifyLead(avokadoLead, {recipient: A}), true, label);
    assert.equal(sent[0].to, A);
  }
});

test('direct list notify (previous single-message path): partial or unknown ACK is not a full success', async () => {
  const env = {LEADS_NOTIFY_EMAIL_AVOKADO: `${A}, ${B}`};
  const full = directNotifier(env, {accepted: [B, 'owner@Example.Test']});
  assert.equal(await full.notifier.notifyLead(avokadoLead), true);
  assert.equal(full.sent[0].to, `${A}, ${B}`);
  for (const [label, ack, code] of [['partial', {accepted: [A], rejected: [B]}, 'EMAIL_DELIVERY_UNCONFIRMED'],
    ['unknown', undefined, 'EMAIL_DELIVERY_UNCONFIRMED'], ['wrong', {accepted: [C]}, 'EMAIL_DELIVERY_UNCONFIRMED'],
    ['refused', {accepted: []}, 'EMAIL_RECIPIENT_REJECTED']]) {
    const {notifier} = directNotifier(env, ack);
    await assert.rejects(notifier.notifyLead(avokadoLead), {code}, label);
  }
  const single = directNotifier({LEADS_NOTIFY_EMAIL_AVOKADO: A}, {accepted: ['owner@Example.TEST']});
  assert.equal(await single.notifier.notifyLead(avokadoLead), true, 'the previous single recipient with a domain-case ACK still succeeds');
});

test('queue: unknown, wrong or malformed ACK never marks an address accepted or the job sent', async t => {
  for (const [label, ack] of UNCONFIRMED_ACKS) {
    const f = fixture(t);
    f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
    f.smtp.script.set(A, () => Promise.resolve(ack));
    const queue = f.outbox();
    queue.enqueue(f.lead(1));
    await queue.drain();
    assert.equal(f.job(1).status, 'pending', label);
    assert.equal(f.job(1).last_error_code, 'EMAIL_DELIVERY_UNCONFIRMED', label);
    assert.deepEqual(f.recipients(1), {[A]: 'pending', [B]: 'pending'}, label);
    assert.deepEqual(f.smtp.sent.map(message => message.to), [A], `${label}: an untrusted ACK stops the claim`);
    const stored = JSON.stringify(f.db.prepare('SELECT * FROM lead_email_recipients').all()) + JSON.stringify(f.job(1)) + f.logs.join('\n');
    assert.doesNotMatch(stored, /SENTINEL|other@|Bcc/, `${label}: no raw SMTP data is stored or logged`);
    f.smtp.script.delete(A);
    f.advance(RETRY_DELAYS[0]);
    await queue.drain();
    assert.equal(f.job(1).status, 'sent', `${label}: a later confirmed attempt completes the job`);
    assert.deepEqual(f.recipients(1), {[A]: 'accepted', [B]: 'accepted'});
  }
});

test('queue: after a confirmed first address, a wrong ACK for the second keeps the job pending', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: `${A}, ${B}`});
  f.smtp.script.set(B, () => Promise.resolve({accepted: [A], rejected: [B]}));
  const queue = f.outbox();
  queue.enqueue(f.lead(1));
  await queue.drain();
  assert.deepEqual(f.recipients(1), {[A]: 'accepted', [B]: 'pending'});
  assert.equal(f.job(1).status, 'pending');
  assert.equal(f.job(1).last_error_code, 'EMAIL_DELIVERY_UNCONFIRMED');
  f.smtp.script.set(B, () => Promise.resolve({accepted: [{address: 'admin@EXAMPLE.test'}]}));
  f.advance(RETRY_DELAYS[0]);
  await queue.drain();
  assert.equal(f.job(1).status, 'sent', 'an address object with a domain in another case confirms the address');
  assert.equal(f.smtp.to(A), 1, 'the confirmed address is not repeated');
  const status = createEmailDiagnostics(f.db, {getEnvironment: f.store.getEnvironment}).getStatus('avokado');
  assert.equal(status.companies[0].sent, 1);
});

test('diagnostics keep the unconfirmed category instead of a generic failure', async t => {
  const f = fixture(t);
  f.store.save(sender); f.store.saveCompany('avokado', {recipient: A});
  f.smtp.script.set(A, () => Promise.resolve(undefined));
  const queue = f.outbox();
  queue.enqueue(f.lead(1));
  await queue.drain();
  const status = createEmailDiagnostics(f.db, {getEnvironment: f.store.getEnvironment}).getStatus('avokado');
  assert.deepEqual(status.companies[0].errors, [{code: 'EMAIL_DELIVERY_UNCONFIRMED', count: 1}]);
  assert.equal(status.companies[0].queued, 1);
});
