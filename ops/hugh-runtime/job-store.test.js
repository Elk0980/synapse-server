'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {createJobStore} = require('./job-store');
const {tempDir, removeDir} = require('./test-support/harness');

async function withStore(run, options = {}) {
  const dir = tempDir('hugh-store-');
  const file = path.join(dir, 'state.sqlite');
  const store = createJobStore(file, options);
  try {
    return await run(store, file, dir);
  } finally {
    store.close();
    await removeDir(dir);
  }
}

test('повторный запрос с тем же содержимым отдаёт сохранённый ответ', () =>
  withStore((store) => {
    assert.deepEqual(store.claim('palitra', 'job-1', 'hash-1'), {lease: true});
    store.complete('palitra', 'job-1', 'ответ', 'gpt-test');
    assert.deepEqual(store.claim('palitra', 'job-1', 'hash-1'), {reuse: {text: 'ответ', model: 'gpt-test'}});
  }));

test('готовый ответ переживает перезапуск процесса', async () => {
  const dir = tempDir('hugh-store-');
  const file = path.join(dir, 'state.sqlite');
  const first = createJobStore(file);
  first.claim('palitra', 'job-1', 'hash-1');
  first.complete('palitra', 'job-1', 'ответ', 'gpt-test');
  first.close();

  const second = createJobStore(file);
  second.recoverInterrupted();
  assert.deepEqual(second.claim('palitra', 'job-1', 'hash-1'), {reuse: {text: 'ответ', model: 'gpt-test'}});
  second.close();
  await removeDir(dir);
});

test('тот же ключ с другим содержимым — конфликт', () =>
  withStore((store) => {
    store.claim('palitra', 'job-1', 'hash-1');
    store.complete('palitra', 'job-1', 'ответ', null);
    assert.throws(() => store.claim('palitra', 'job-1', 'hash-2'), (error) => error.status === 409);
  }));

test('незавершённое задание в работе отвечает «занято», а не запускает второе', () =>
  withStore((store) => {
    store.claim('palitra', 'job-1', 'hash-1');
    assert.throws(() => store.claim('palitra', 'job-1', 'hash-1'), (error) => error.status === 429);
  }));

test('брошенная аренда после аварии становится повторяемой', () =>
  withStore(
    (store) => {
      store.claim('palitra', 'job-1', 'hash-1');
      store.recoverInterrupted();
      assert.equal(store.get('palitra', 'job-1').status, 'failed');
      assert.deepEqual(store.claim('palitra', 'job-1', 'hash-1'), {lease: true});
    },
    {leaseMs: -1},
  ));

test('одинаковые ключи разных компаний не пересекаются', () =>
  withStore((store) => {
    store.claim('palitra', 'job-1', 'hash-1');
    store.complete('palitra', 'job-1', 'ответ палитры', null);
    assert.deepEqual(store.claim('alvi', 'job-1', 'hash-2'), {lease: true});
    store.complete('alvi', 'job-1', 'ответ ALVI', null);
    assert.equal(store.get('palitra', 'job-1').reply_text, 'ответ палитры');
  }));

test('готовый ответ не затирается более поздней ошибкой', () =>
  withStore((store) => {
    store.claim('palitra', 'job-1', 'hash-1');
    store.complete('palitra', 'job-1', 'ответ', null);
    store.fail('palitra', 'job-1', 'TIMEOUT');
    const row = store.get('palitra', 'job-1');
    assert.equal(row.status, 'completed');
    assert.equal(row.reply_text, 'ответ');
  }));

test('старые записи удаляются, история retry-горизонта сохраняется', () => {
  let clock = Date.now();
  return withStore(
    (store) => {
      store.claim('palitra', 'old', 'hash-1');
      store.complete('palitra', 'old', 'старое', null);
      clock += 4 * 3600 * 1000;
      store.claim('palitra', 'fresh', 'hash-2');
      store.complete('palitra', 'fresh', 'свежее', null);
      store.prune();
      assert.equal(store.get('palitra', 'old'), null);
      assert.ok(store.get('palitra', 'fresh'));
    },
    {retentionHours: 2, now: () => clock},
  );
});

test('снятие аренды не оставляет следа и не трогает готовый ответ', () =>
  withStore((store) => {
    store.claim('palitra', 'job-1', 'hash-1');
    store.release('palitra', 'job-1');
    assert.equal(store.get('palitra', 'job-1'), null);
    assert.deepEqual(store.claim('palitra', 'job-1', 'hash-1'), {lease: true});

    store.complete('palitra', 'job-1', 'ответ', null);
    store.release('palitra', 'job-1');
    assert.equal(store.get('palitra', 'job-1').reply_text, 'ответ', 'готовый ответ не удаляется');
  }));

test('ожидание по лимиту подписки хранится и снимается', () =>
  withStore((store) => {
    assert.equal(store.readLimit(), null);
    const until = Date.now() + 60_000;
    store.saveLimit({reason: 'rate_limit', until});
    const saved = store.readLimit();
    assert.equal(saved.reason, 'rate_limit');
    assert.equal(saved.until_ms, Math.trunc(until));
    store.saveLimit({reason: 'overloaded', until: until + 1000});
    assert.equal(store.readLimit().reason, 'overloaded');
    store.clearLimit();
    assert.equal(store.readLimit(), null);
  }));

test('состояние входа хранится без токенов', () =>
  withStore((store) => {
    store.saveLogin({status: 'pending', loginId: 'login-1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: 123});
    const saved = store.readLogin();
    assert.equal(saved.status, 'pending');
    assert.equal(saved.user_code, 'ABCD-1234');
    assert.deepEqual(Object.keys(saved).sort(), ['expires_at', 'id', 'login_id', 'status', 'updated_at', 'user_code', 'verification_url']);
    store.saveLogin({status: 'interrupted'});
    assert.equal(store.readLogin().status, 'interrupted');
    assert.equal(store.readLogin().login_id, null);
  }));
