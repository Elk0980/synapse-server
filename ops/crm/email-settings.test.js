'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createEmailSettings} = require('./email-settings');
const {createEmailOutbox} = require('./email-outbox');
const {createEmailDiagnostics} = require('./email-diagnostics');
const apiKey = 'fixture-key-not-a-live-credential';
const payload = {provider: 'mailru', user: 'sender@example.test', password: 'SENTINEL_PASSWORD',
  alviRecipient: 'alvi@example.test', avokadoRecipient: 'avokado@example.test'};
const lead = {company_code: 'avokado', name: 'Fixture', contact: 'fixture@example.test', created_at: '2026-09-15T00:00:00Z'};
function fixture(environment = {}, transportFactory) {
  const db = new DatabaseSync(':memory:'), calls = {construct: [], verify: [], send: []};
  const createTransport = options => {
    calls.construct.push(options);
    return transportFactory ? transportFactory(options) : {
      async verify() { calls.verify.push(options); return true; },
      async sendMail(message) { calls.send.push({options, message}); return {accepted: [message.to]}; }
    };
  };
  const options = {apiKey, environment, createTransport, now: () => Date.parse('2026-09-15T10:00:00Z')};
  return {db, calls, options, store: createEmailSettings(db, options), close() { db.close(); }};
}
const row = db => ({...db.prepare('SELECT * FROM email_settings WHERE singleton=1').get()});
const isBadInput = error => error.status === 400 && !/SENTINEL/.test(error.message);

test('GET defaults to environment without writing settings or constructing SMTP', () => {
  const f = fixture({LEADS_NOTIFY_EMAIL_AVOKADO: 'avokado@example.test'});
  try {
    assert.deepEqual(f.store.getPublic(), {provider: 'yandex', user: '', alviRecipient: '',
      avokadoRecipient: 'avokado@example.test', passwordConfigured: false, source: 'none', updatedAt: null, needsPassword: true});
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM email_settings').get().n, 0);
    assert.deepEqual(f.calls, {construct: [], verify: [], send: []});
  } finally { f.close(); }
});

test('save encrypts the full configuration and returns only the public contract without connections', () => {
  const f = fixture();
  try {
    const saved = f.store.save({...payload, user: ' sender@example.test ', alviRecipient: ' alvi@example.test '});
    assert.deepEqual(saved, {provider: 'mailru', user: 'sender@example.test', alviRecipient: 'alvi@example.test',
      avokadoRecipient: 'avokado@example.test', passwordConfigured: true, source: 'cabinet',
      updatedAt: '2026-09-15T10:00:00.000Z', needsPassword: false});
    const encoded = JSON.stringify(row(f.db));
    for (const value of [...Object.values(payload), apiKey]) assert.equal(encoded.includes(value), false);
    assert.doesNotMatch(JSON.stringify(saved), /SENTINEL_PASSWORD|ciphertext|encrypted_json|apiKey/);
    assert.deepEqual(f.calls, {construct: [], verify: [], send: []});
    const reopened = createEmailSettings(f.db, f.options);
    assert.deepEqual(reopened.getPublic(), saved);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM email_settings').get().n, 1);
  } finally { f.close(); }
});

test('input rejects unknown fields, arbitrary providers, address lists, injection and excessive values', () => {
  const f = fixture();
  try {
    const invalid = [null, [], {}, {...payload, host: 'SENTINEL_HOST'}, {...payload, SENTINEL_UNKNOWN: 'SENTINEL'},
      {...payload, provider: 'localhost'}, {...payload, provider: '__proto__'}, {...payload, user: ''},
      {...payload, user: 'Name <sender@example.test>'}, {...payload, user: 'a@example.test,b@example.test'},
      {...payload, user: 'a@example.test\r\nBcc: attacker@example.test'}, {...payload, user: 'a'.repeat(65) + '@example.test'},
      {...payload, user: 'foo..bar@example.test'}, {...payload, user: 'sender@-bad.example'},
      {...payload, alviRecipient: ['alvi@example.test']}, {...payload, avokadoRecipient: 'a@example.test;b@example.test'},
      {...payload, alviRecipient: 'x'.repeat(255)}, {...payload, password: 123},
      {...payload, password: 'x'.repeat(513)}, {...payload, password: 'SENTINEL\nHEADER'},
      {...payload, password: null}];
    for (const body of invalid) assert.throws(() => f.store.save(body), isBadInput);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM email_settings').get().n, 0);
    assert.deepEqual(f.calls, {construct: [], verify: [], send: []});
  } finally { f.close(); }
});

test('first save needs a password; later same-sender saves preserve it, sender changes do not', async () => {
  const f = fixture({LEADS_SMTP_USER: payload.user, LEADS_SMTP_PASSWORD: 'SENTINEL_ENV_PASSWORD', LEADS_SMTP_HOST: 'smtp.mail.ru'});
  try {
    assert.equal(f.store.getPublic().passwordConfigured, true);
    assert.equal(f.store.getPublic().needsPassword, true);
    const withoutPassword = {...payload}; delete withoutPassword.password;
    assert.throws(() => f.store.save(withoutPassword), isBadInput);
    f.store.save(payload);
    const firstCipher = row(f.db).encrypted_json;
    f.store.save({...withoutPassword, password: '  ', alviRecipient: ''});
    assert.notEqual(row(f.db).encrypted_json, firstCipher, 'fresh nonce protects repeated saves');
    await f.store.check();
    assert.equal(f.calls.construct[0].auth.pass, payload.password);
    assert.equal(f.store.getPublic().alviRecipient, '');
    assert.throws(() => f.store.save({...withoutPassword, provider: 'yandex'}), isBadInput);
    assert.throws(() => f.store.save({...withoutPassword, user: 'other@example.test'}), isBadInput);
    f.store.save({...withoutPassword, user: 'other@example.test', password: 'NEW_SENTINEL_PASSWORD'});
    await f.store.check();
    assert.equal(f.calls.construct[1].auth.pass, 'NEW_SENTINEL_PASSWORD');
    assert.equal(f.calls.construct[1].auth.user, 'other@example.test');
    assert.equal(f.calls.send.length, 0);
  } finally { f.close(); }
});

test('saved whole SMTP configuration overrides environment and diagnostics update immediately', async () => {
  const f = fixture({LEADS_SMTP_HOST: 'smtp.yandex.ru', LEADS_SMTP_PORT: '465',
    LEADS_SMTP_USER: 'env@example.test', LEADS_SMTP_PASSWORD: 'SENTINEL_ENV_PASSWORD',
    LEADS_MAIL_FROM: 'env-from@example.test', LEADS_NOTIFY_EMAIL_ALVI: 'env-alvi@example.test'});
  try {
    f.db.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, company_code TEXT)');
    createEmailOutbox(f.db, f.store.notifications);
    const diagnostics = createEmailDiagnostics(f.db, {getEnvironment: f.store.getEnvironment});
    assert.equal(f.store.getPublic().source, 'environment');
    assert.equal(diagnostics.getStatus().companies[0].recipientConfigured, true);
    f.store.save({...payload, alviRecipient: ''});
    assert.equal(f.store.getPublic().source, 'cabinet');
    assert.equal(diagnostics.getStatus().smtp.configured, true);
    assert.deepEqual(diagnostics.getStatus().companies.map(company => company.recipientConfigured), [false, true]);
    assert.equal(f.calls.construct.length, 0);
    await f.store.notifications.notifyLead(lead);
    assert.equal(f.calls.send[0].options.host, 'smtp.mail.ru');
    assert.equal(f.calls.send[0].message.from, payload.user);
    assert.equal(f.calls.send[0].message.to, payload.avokadoRecipient);
    await assert.rejects(f.store.notifications.notifyLead({...lead, company_code: 'alvi'}), {code: 'EMAIL_RECIPIENT_MISSING'});
    assert.equal(f.calls.send.length, 1);
  } finally { f.close(); }
});

test('key rotation and ciphertext tampering fail closed without deleting data or falling back to environment', async () => {
  const f = fixture({LEADS_SMTP_USER: 'env@example.test', LEADS_SMTP_PASSWORD: 'SENTINEL_ENV_PASSWORD'});
  try {
    f.store.save(payload);
    const original = row(f.db);
    const rotated = createEmailSettings(f.db, {...f.options, apiKey: 'different-fixture-key'});
    const publicState = rotated.getPublic();
    assert.equal(publicState.source, 'cabinet'); assert.equal(publicState.needsPassword, true);
    assert.equal(publicState.passwordConfigured, false); assert.equal(publicState.user, '');
    assert.deepEqual(await rotated.check(), {ok: false, code: 'SMTP_NOT_CONFIGURED'});
    assert.equal(await rotated.notifications.notifyLead(lead), false);
    assert.deepEqual(row(f.db), original);
    assert.throws(() => rotated.save({...payload, password: ''}), isBadInput);
    const envelope = JSON.parse(original.encrypted_json);
    envelope.tag = Buffer.alloc(16).toString('base64');
    const tampered = JSON.stringify(envelope);
    f.db.prepare('UPDATE email_settings SET encrypted_json=?').run(tampered);
    assert.equal(f.store.getPublic().needsPassword, true);
    assert.equal(row(f.db).encrypted_json, tampered);
    assert.deepEqual(f.calls, {construct: [], verify: [], send: []});
    rotated.save({...payload, password: 'REENTERED_SENTINEL_PASSWORD'});
    assert.equal(rotated.getPublic().needsPassword, false);
  } finally { f.close(); }
});

test('other companies keep the generic recipient while explicitly disabled studios never fall back to it', async () => {
  const f = fixture({LEADS_NOTIFY_EMAIL: 'generic@example.test', LEADS_NOTIFY_EMAIL_ALVI: 'old-alvi@example.test',
    LEADS_NOTIFY_EMAIL_AVOKADO: 'old-avokado@example.test'});
  try {
    f.store.save({...payload, alviRecipient: '', avokadoRecipient: ''});
    await f.store.notifications.notifyLead({...lead, company_code: 'other'});
    assert.equal(f.calls.send[0].message.to, 'generic@example.test');
    assert.equal(f.calls.send[0].message.from, payload.user);
    for (const company of ['alvi', 'avokado']) {
      await assert.rejects(f.store.notifications.notifyLead({...lead, company_code: company}), {code: 'EMAIL_RECIPIENT_MISSING'});
    }
    assert.equal(f.calls.send.length, 1);
    assert.equal(f.store.getPublic().alviRecipient, '');
    assert.equal(f.store.getPublic().avokadoRecipient, '');
  } finally { f.close(); }
});

test('check verifies only the fixed TLS endpoint, with existing timeouts, and never sends mail', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.store.check(), {ok: false, code: 'SMTP_NOT_CONFIGURED'});
    assert.equal(f.calls.construct.length, 0);
    f.store.save(payload);
    const before = row(f.db);
    assert.deepEqual(await f.store.check(), {ok: true});
    assert.deepEqual(f.calls.construct[0], {host: 'smtp.mail.ru', port: 465, secure: true,
      auth: {user: payload.user, pass: payload.password}, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000});
    assert.equal(f.calls.verify.length, 1); assert.equal(f.calls.send.length, 0);
    assert.deepEqual(row(f.db), before);
  } finally { f.close(); }
});

test('verification failures return only a safe diagnostic code', async () => {
  for (const [code, expected] of [['EAUTH', 'SMTP_AUTH'], ['ETIMEDOUT', 'SMTP_CONNECTION'], ['SENTINEL_UNKNOWN', 'SMTP_SEND_FAILED']]) {
    const f = fixture({}, () => ({async verify() { throw Object.assign(new Error('SENTINEL_PASSWORD PRIVATE_RESPONSE'), {code}); },
      sendMail() { assert.fail('check must never send mail'); }}));
    try {
      f.store.save(payload);
      const result = await f.store.check();
      assert.deepEqual(result, {ok: false, code: expected});
      assert.doesNotMatch(JSON.stringify(result), /SENTINEL|PRIVATE_RESPONSE/);
    } finally { f.close(); }
  }
});

test('a settings update changes future deliveries while an in-flight delivery keeps its original transport', async () => {
  let finishOld;
  const sent = [];
  const f = fixture({}, options => ({async verify() { return true; }, sendMail(message) {
    sent.push({options, message});
    return sent.length === 1 ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({accepted: [message.to]});
  }}));
  try {
    f.store.save(payload);
    const first = f.store.notifications.notifyLead(lead);
    f.store.save({...payload, provider: 'yandex', user: 'next@example.test', password: 'NEXT_SENTINEL_PASSWORD', avokadoRecipient: 'next-owner@example.test'});
    assert.equal(sent.length, 1, 'saving must not trigger delivery');
    await f.store.notifications.notifyLead(lead);
    assert.equal(sent[0].options.host, 'smtp.mail.ru'); assert.equal(sent[0].message.to, payload.avokadoRecipient);
    assert.equal(sent[1].options.host, 'smtp.yandex.ru'); assert.equal(sent[1].message.to, 'next-owner@example.test');
    finishOld({accepted: [payload.avokadoRecipient]});
    assert.equal(await first, true);
  } finally { f.close(); }
});

test('a failed database save preserves the prior settings and hides database error details', () => {
  const f = fixture();
  try {
    f.store.save(payload); const before = row(f.db);
    f.db.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON email_settings BEGIN SELECT RAISE(ABORT, 'SENTINEL_DB_ERROR'); END");
    assert.throws(() => f.store.save({...payload, user: 'next@example.test'}), error => error.status === 500 && !/SENTINEL/.test(error.message));
    assert.deepEqual(row(f.db), before);
    assert.equal(f.store.getPublic().user, payload.user);
  } finally { f.close(); }
});
