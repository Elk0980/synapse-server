'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {publicRuntimeStatus, sanitizeServerStats, buildStatusDocument, writeStatusFile} = require('./status-file');
const {tempDir, removeDir} = require('./test-support/fakes');

test('publicRuntimeStatus оставляет только поля контракта и приводит типы', () => {
  const status = publicRuntimeStatus({
    state: 'connected',
    authenticated: 1,
    connected: true,
    available: 'yes',
    limited: false,
    retryAfter: '12.7',
    provider: 'evil',
    model: 'gpt-5.5',
    loginUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
    error: 'Сырое сообщение',
    errorCode: 'bad code',
    safety: {toolIsolationVerified: true, reason: 'proof_ok', extra: 1},
    version: '0.154.0',
  });
  assert.deepEqual(status, {
    state: 'connected',
    authenticated: false,
    connected: true,
    available: false,
    limited: false,
    retryAfter: 12,
    provider: 'codex',
    model: 'gpt-5.5',
    safety: {toolIsolationVerified: true, reason: 'proof_ok'},
    errorCode: null,
  });
  assert.equal(publicRuntimeStatus({state: 'weird'}).state, 'unavailable');
  assert.equal(publicRuntimeStatus(null).errorCode, null);
  assert.equal(publicRuntimeStatus({errorCode: 'RATE_LIMITED'}).errorCode, 'RATE_LIMITED');
});

test('sanitizeServerStats: только согласованные метрики', () => {
  assert.deepEqual(sanitizeServerStats({lastSeen: 'nope', offline: 'true', pendingAi: -3, oldestPendingAgeSeconds: null, humanMessagesWhileOffline24h: 2, aiRequestsWhileOffline24h: 1e12, chat: 'text'}), {
    lastSeen: null,
    offline: false,
    pendingAi: null,
    oldestPendingAgeSeconds: null,
    humanMessagesWhileOffline24h: 2,
    aiRequestsWhileOffline24h: 2 ** 31 - 1,
  });
});

test('buildStatusDocument + writeStatusFile: атомарная запись безопасного документа', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state', 'status.json');
    const document = buildStatusDocument({
      updatedAt: '2026-09-17T10:00:00.000Z',
      bootId: 'boot-1',
      startedAt: '2026-09-17T09:59:00.000Z',
      worker: {version: '1.0.0', running: true, activeJob: {kind: 'login', claimedAt: '2026-09-17T10:00:00.000Z', leaseLost: false}, outboxPending: 1, counters: {claims: 3, unknown: 9}, lastTransport: {operation: 'claim', status: 200, category: null, at: 'x'}},
      runtime: {state: 'connected', userCode: 'ABCD-1234', loginUrl: 'https://auth.openai.com/codex/device', error: 'text', version: '0.154.0'},
      loginPending: true,
      server: {lastHeartbeatOk: true, lastHeartbeatAt: '2026-09-17T10:00:00.000Z', stats: {pendingAi: 1}},
    });
    writeStatusFile(file, document);
    writeStatusFile(file, document); // повторная запись поверх существующего файла
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.worker.activeJob.kind, 'login');
    assert.equal(parsed.worker.counters.claims, 3);
    assert.equal('unknown' in parsed.worker.counters, false);
    assert.equal(parsed.worker.lastTransport.at, null);
    assert.equal(parsed.runtime.version, '0.154.0');
    assert.equal(parsed.runtime.loginPending, true);
    assert.equal(parsed.server.stats.pendingAi, 1);
    const text = JSON.stringify(parsed);
    assert.ok(!text.includes('ABCD-1234'));
    assert.ok(!text.includes('auth.openai.com'));
    assert.ok(!text.includes('"error"'));
  } finally {
    await removeDir(dir);
  }
});
