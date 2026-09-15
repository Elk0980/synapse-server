'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createEmailOutbox, RETRY_DELAYS, LEASE_MS} = require('./email-outbox');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE leads (id INTEGER PRIMARY KEY, name TEXT, contact TEXT, company_code TEXT, created_at TEXT);
    INSERT INTO leads VALUES (1,'Test','test@example.test','alvi','2026-09-15T00:00:00Z');
    INSERT INTO leads VALUES (2,'Test','test2@example.test','avokado','2026-09-15T00:00:00Z');`);
  t.after(() => db.close());
  const logs = [];
  let time = Date.parse('2026-09-15T12:00:00Z');
  const options = {now: () => time, logger: {warn: text => logs.push(text)}};
  const row = id => db.prepare('SELECT * FROM lead_email_outbox WHERE lead_id = ?').get(id);
  return {db, logs, options, row, advance: ms => {time += ms;}};
}

test('a failed delivery survives worker recreation, retries when due, and is not resent after success', async t => {
  const s = fixture(t); let calls = 0;
  const notifications = {notifyLead: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('private password contact@example.test'), {code: 'EAUTH'});
    return true;
  }};
  const first = createEmailOutbox(s.db, notifications, s.options);
  assert.equal(s.row(1), undefined, 'does not backfill old leads at startup');
  first.enqueue({id: 1});
  await first.drain();
  assert.equal(s.row(1).status, 'pending');
  assert.equal(s.row(1).last_error_code, 'SMTP_AUTH');
  assert.equal(s.row(1).attempts, 1);
  assert.ok(s.logs.every(line => !/private|password|@/.test(line)));
  await first.stop();
  const restarted = createEmailOutbox(s.db, notifications, s.options);
  await restarted.drain();
  assert.equal(calls, 1, 'respects retry delay');
  s.advance(RETRY_DELAYS[0]);
  await restarted.drain();
  assert.equal(s.row(1).status, 'sent');
  assert.equal(s.row(1).attempts, 2);
  assert.equal(s.row(1).last_error_code, null);
  restarted.enqueue({id: 1}, {repeated: true});
  await restarted.drain();
  assert.equal(calls, 2, 'duplicate submission cannot resend delivered email');
});

test('disabled SMTP keeps the request pending; a repeated form wakes that delivery once', async t => {
  const s = fixture(t); let enabled = false; const sent = [];
  const queue = createEmailOutbox(s.db, {notifyLead: async (lead, meta) => {
    if (!enabled) return false;
    sent.push({id: lead.id, meta}); return true;
  }}, s.options);
  queue.enqueue({id: 1}, {repeated: true});
  await queue.drain();
  assert.equal(s.row(1).last_error_code, 'SMTP_NOT_CONFIGURED');
  assert.equal(s.row(1).status, 'pending');
  enabled = true;
  queue.enqueue({id: 1}, {repeated: true});
  queue.enqueue({id: 1}, {repeated: true});
  await queue.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].meta.messageId, '<synapse-lead-1@synapsebusiness.ru>');
  assert.equal(sent[0].meta.repeatedAt, s.row(1).created_at);
});

test('overlapping worker calls claim a request once and do not block the queue after another recipient fails', async t => {
  const s = fixture(t); const calls = []; let resolveFirst;
  const queue = createEmailOutbox(s.db, {notifyLead: lead => {
    calls.push(lead.id);
    if (lead.id === 1) return new Promise(resolve => {resolveFirst = resolve;});
    return Promise.reject(Object.assign(new Error('private address'), {code: 'EMAIL_RECIPIENT_MISSING'}));
  }}, s.options);
  queue.enqueue({id: 1}); queue.enqueue({id: 2});
  const first = queue.drain(), overlap = queue.drain();
  assert.equal(first, overlap);
  assert.equal(s.row(1).status, 'sending');
  resolveFirst(true); await first;
  assert.deepEqual(calls, [1, 2]);
  assert.equal(s.row(1).status, 'sent');
  assert.equal(s.row(2).status, 'pending');
  assert.equal(s.row(2).last_error_code, 'EMAIL_RECIPIENT_MISSING');
});

test('an interrupted send is retried after its lease expires; deleted leads remove their pending mail', async t => {
  const s = fixture(t); const calls = [];
  const queue = createEmailOutbox(s.db, {notifyLead: async lead => {calls.push(lead.id); return true;}}, s.options);
  queue.enqueue({id: 1}); queue.enqueue({id: 2});
  s.db.prepare("UPDATE lead_email_outbox SET status='sending',last_attempt_at=created_at WHERE lead_id=1").run();
  s.db.prepare('DELETE FROM leads WHERE id=2').run();
  await queue.drain();
  assert.deepEqual(calls, []);
  s.advance(LEASE_MS);
  await queue.drain();
  assert.deepEqual(calls, [1]);
  assert.equal(s.row(1).status, 'sent');
  assert.equal(s.row(2), undefined);
});

test('shutdown waits for the current delivery and leaves the rest durable for the next worker', async t => {
  const s = fixture(t); const calls = []; let finish;
  const queue = createEmailOutbox(s.db, {notifyLead: lead => {
    calls.push(lead.id); return new Promise(resolve => {finish = resolve;});
  }}, s.options);
  queue.enqueue({id: 1}); queue.enqueue({id: 2});
  const pending = queue.drain();
  const stopped = queue.stop();
  finish(true); await stopped; await pending;
  assert.deepEqual(calls, [1]);
  assert.equal(s.row(1).status, 'sent');
  assert.equal(s.row(2).status, 'pending');
});

test('a superseded worker cannot complete or reopen another worker\'s delivery', async t => {
  for (const staleSucceedsFirst of [false, true]) {
    const s = fixture(t); let finishOld, finishNew; const calls = [];
    const old = createEmailOutbox(s.db, {notifyLead: () => {
      calls.push('old'); return new Promise((resolve, reject) => {finishOld = {resolve, reject};});
    }}, s.options);
    const fresh = createEmailOutbox(s.db, {notifyLead: () => {
      calls.push('new'); return new Promise((resolve, reject) => {finishNew = {resolve, reject};});
    }}, s.options);
    old.enqueue({id: 1});
    const oldRun = old.drain();
    await fresh.drain();
    assert.deepEqual(calls, ['old'], 'another worker cannot claim a live lease');
    s.advance(LEASE_MS + 1);
    const freshRun = fresh.drain();
    assert.deepEqual(calls, ['old', 'new']);
    assert.equal(s.row(1).attempts, 2);
    if (staleSucceedsFirst) {
      finishOld.resolve(true); await oldRun;
      assert.equal(s.row(1).status, 'sending', 'stale success cannot finish the current attempt');
      finishNew.reject(Object.assign(new Error('synthetic'), {code: 'ETIMEDOUT'})); await freshRun;
      assert.equal(s.row(1).status, 'pending');
      assert.equal(s.row(1).last_error_code, 'SMTP_CONNECTION');
    } else {
      finishNew.resolve(true); await freshRun;
      finishOld.reject(Object.assign(new Error('synthetic'), {code: 'ETIMEDOUT'})); await oldRun;
      assert.equal(s.row(1).status, 'sent', 'stale failure cannot reopen a delivered notification');
      assert.equal(s.row(1).last_error_code, null);
      assert.equal(s.logs.length, 0, 'stale failures are not logged as pending');
    }
  }
});
