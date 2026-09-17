'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {createOutbox} = require('./outbox');
const {tempDir, removeDir} = require('./test-support/fakes');

const job = (overrides = {}) => ({
  jobId: '42',
  kind: 'reply',
  companyCode: 'palitra-love',
  payload: {jobId: 'project-chat:42'},
  payloadHash: 'a'.repeat(64),
  leaseToken: 'lease-token-0001',
  leaseExpiresAt: '2026-09-17T10:03:00.000Z',
  bootId: 'boot-1',
  claimedAt: 1000,
  ...overrides,
});

test('активное задание сохраняется, читается и снимается', () => {
  const outbox = createOutbox(':memory:', {now: () => 5000});
  assert.equal(outbox.readActiveJob(), null);
  outbox.saveActiveJob(job());
  const active = outbox.readActiveJob();
  assert.equal(active.jobId, '42');
  assert.deepEqual(active.payload, {jobId: 'project-chat:42'});
  assert.equal(active.leaseExpiresAt, '2026-09-17T10:03:00.000Z');
  assert.equal(active.claimedAt, 1000);
  outbox.saveActiveJob(job({jobId: '43', leaseToken: 'lease-token-0002'}));
  assert.equal(outbox.readActiveJob().jobId, '43'); // ровно одно активное задание
  outbox.clearActiveJob();
  assert.equal(outbox.readActiveJob(), null);
  outbox.close();
});

test('enqueue пишет результат и снимает активное задание одной транзакцией', () => {
  let time = 1000;
  const outbox = createOutbox(':memory:', {now: () => time});
  outbox.saveActiveJob(job());
  outbox.enqueue({jobId: '42', kind: 'reply', companyCode: 'palitra-love', leaseToken: 'lease-token-0001', payloadHash: 'a'.repeat(64), result: {ok: true, text: 'Ответ', provider: 'codex', model: 'gpt-5.5'}});
  assert.equal(outbox.readActiveJob(), null);
  assert.equal(outbox.pendingCount(), 1);
  const [pending] = outbox.pending();
  assert.equal(pending.jobId, '42');
  assert.deepEqual(pending.result, {ok: true, text: 'Ответ', provider: 'codex', model: 'gpt-5.5'});
  assert.equal(pending.attempts, 0);

  time = 2000;
  outbox.recordAttempt('42', 'network');
  assert.equal(outbox.get('42').attempts, 1);
  assert.equal(outbox.get('42').lastCategory, 'network');
  assert.equal(outbox.get('42').lastAttemptAt, 2000);

  time = 3000;
  outbox.markAcked('42', 'accepted');
  assert.equal(outbox.pendingCount(), 0);
  assert.equal(outbox.get('42').ackedAt, 3000);
  assert.equal(outbox.get('42').outcome, 'accepted');
  outbox.markAcked('42', 'rejected'); // повторная отметка ничего не меняет
  assert.equal(outbox.get('42').outcome, 'accepted');
  outbox.close();
});

test('pruneAcked удаляет только подтверждённые записи; неподтверждённые остаются навсегда', () => {
  let time = 0;
  const outbox = createOutbox(':memory:', {now: () => time});
  const entry = (id) => ({jobId: id, kind: 'reply', companyCode: 'palitra-love', leaseToken: 'lease-token-0001', payloadHash: 'a'.repeat(64), result: {ok: true, text: 't', provider: 'codex', model: null}});
  outbox.enqueue(entry('old-unacked'));
  outbox.enqueue(entry('old-acked'));
  outbox.markAcked('old-acked', 'accepted');
  time = 1000 * 3600 * 1000; // далеко в будущем
  outbox.enqueue(entry('fresh'));
  outbox.pruneAcked(72 * 3600 * 1000);
  assert.equal(outbox.get('old-acked'), null);
  assert.ok(outbox.get('old-unacked'));
  assert.ok(outbox.get('fresh'));
  assert.deepEqual(outbox.pending().map((item) => item.jobId), ['old-unacked', 'fresh']);
  outbox.close();
});

test('состояние переживает переоткрытие файла', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'outbox.sqlite');
  try {
    const first = createOutbox(file);
    first.saveActiveJob(job());
    first.enqueue({jobId: '41', kind: 'login', companyCode: 'palitra-love', leaseToken: 'lease-token-0009', payloadHash: 'b'.repeat(64), result: {ok: false, errorCode: 'UNAVAILABLE', retryAfter: 60}});
    first.saveActiveJob(job({jobId: '42'}));
    first.close();
    const second = createOutbox(file);
    assert.equal(second.readActiveJob().jobId, '42');
    assert.equal(second.pendingCount(), 1);
    assert.deepEqual(second.pending()[0].result, {ok: false, errorCode: 'UNAVAILABLE', retryAfter: 60});
    second.close();
  } finally {
    await removeDir(dir);
  }
});
