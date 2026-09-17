'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedVerificationUrl,
  isAllowedUserCode,
  parseDeviceLoginResponse,
  matchLoginCompleted,
  parseAccount,
} = require('./device-login');
const {createRuntime, happyScenario, chatgptAccount} = require('./test-support/harness');

const OFFICIAL = 'https://auth.openai.com/codex/device';

test('разрешён только официальный адрес входа', () => {
  assert.equal(isAllowedVerificationUrl(OFFICIAL), true);
  assert.equal(isAllowedVerificationUrl(`${OFFICIAL}/`), true);
  for (const value of [
    'http://auth.openai.com/codex/device',
    'https://auth.openai.com.evil.example/codex/device',
    'https://auth.openai.com:8443/codex/device',
    'https://user:pass@auth.openai.com/codex/device',
    `${OFFICIAL}?token=секрет`,
    `${OFFICIAL}#секрет`,
    'https://auth.openai.com/codex/device/../../admin',
    'https://evil.example/codex/device',
    'javascript:alert(1)',
    '',
    null,
    123,
  ]) {
    assert.equal(isAllowedVerificationUrl(value), false, String(value));
  }
});

test('код устройства принимается только в официальном формате', () => {
  assert.equal(isAllowedUserCode('ABCD-1234'), true);
  for (const value of ['abcd-1234', 'ABCD1234', 'ABCDE-1234', 'ABCD-1234-5678', 'sk-живойключ', '', null]) {
    assert.equal(isAllowedUserCode(value), false, String(value));
  }
});

test('ответ входа проверяется целиком', () => {
  const good = parseDeviceLoginResponse({type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: OFFICIAL, userCode: 'ABCD-1234'});
  assert.equal(good.ok, true);
  assert.equal(good.verificationUrl, OFFICIAL);
  assert.equal(parseDeviceLoginResponse({type: 'chatgpt', loginId: 'x'}).reason, 'login_type_unexpected');
  assert.equal(parseDeviceLoginResponse({type: 'chatgptDeviceCode', loginId: 'a b', verificationUrl: OFFICIAL, userCode: 'ABCD-1234'}).reason, 'login_id_invalid');
  assert.equal(parseDeviceLoginResponse({type: 'chatgptDeviceCode', loginId: 'l', verificationUrl: 'https://evil.example', userCode: 'ABCD-1234'}).reason, 'login_url_rejected');
  assert.equal(parseDeviceLoginResponse({type: 'chatgptDeviceCode', loginId: 'l', verificationUrl: OFFICIAL, userCode: 'нет'}).reason, 'login_code_rejected');
  assert.equal(parseDeviceLoginResponse(null).reason, 'login_response_invalid');
});

test('уведомление о завершении входа сверяется по loginId', () => {
  assert.deepEqual(matchLoginCompleted({loginId: 'a', success: true}, 'a'), {matched: true, success: true});
  assert.deepEqual(matchLoginCompleted({loginId: 'b', success: true}, 'a'), {matched: false, success: false});
  assert.deepEqual(matchLoginCompleted({success: true}, 'a'), {matched: false, success: false});
});

test('кэш авторизации признаётся только для ChatGPT и без раскрытия почты', () => {
  const parsed = parseAccount(chatgptAccount());
  assert.deepEqual(parsed, {authenticated: true, reason: 'account_chatgpt'});
  assert.equal(parseAccount({account: {type: 'apiKey'}}).authenticated, false);
  assert.equal(parseAccount({account: null}).reason, 'account_absent');
  assert.equal(parseAccount(null).reason, 'account_unreadable');
});

test('вход выдаёт официальную ссылку и код, повторное нажатие не начинает второй вход', async (t) => {
  const harness = createRuntime({
    scenario: happyScenario({account: {account: null, requiresOpenaiAuth: true}}),
  });
  t.after(() => harness.cleanup());
  const first = await harness.runtime.startLogin();
  assert.equal(first.loginUrl, OFFICIAL);
  assert.equal(first.userCode, 'ABCD-1234');
  assert.equal(first.state, 'connecting');
  await harness.runtime.startLogin();
  const starts = harness.received().filter((message) => message.method === 'account/login/start');
  assert.equal(starts.length, 1, 'второй вход не запускался');
  assert.deepEqual(starts[0].params, {type: 'chatgptDeviceCode'});
});

test('подозрительная ссылка входа отклоняется и вход отменяется', async (t) => {
  const canary = 'sk-канарейка';
  const logs = [];
  const logger = {log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m)};
  const harness = createRuntime({
    logger,
    scenario: happyScenario({
      account: {account: null, requiresOpenaiAuth: true},
      loginStart: {
        result: {
          type: 'chatgptDeviceCode',
          loginId: 'login-2',
          verificationUrl: `https://evil.example/codex/device?token=${canary}`,
          userCode: 'ABCD-1234',
        },
      },
    }),
  });
  t.after(() => harness.cleanup());
  await assert.rejects(harness.runtime.startLogin(), (error) => error.code === 'LOGIN_REJECTED');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const cancel = harness.received().find((message) => message.method === 'account/login/cancel');
  assert.deepEqual(cancel.params, {loginId: 'login-2'});
  assert.ok(!logs.join('\n').includes(canary), 'канарейка не попала в журнал');
  const status = harness.runtime.statusSnapshot();
  assert.equal(status.loginUrl, null);
  assert.equal(status.userCode, null);
});

test('успешное уведомление подтверждается повторным чтением учётной записи', async (t) => {
  const scenario = happyScenario({account: {account: null, requiresOpenaiAuth: true}});
  scenario.methods['account/login/start'].after = [
    {method: 'account/login/completed', params: {loginId: 'login-1', success: true, error: null}},
  ];
  scenario.methods['account/login/start'].afterDelayMs = 5;
  const harness = createRuntime({scenario});
  t.after(() => harness.cleanup());
  await harness.runtime.startLogin();
  await new Promise((resolve) => setTimeout(resolve, 80));
  // Учётная запись так и осталась пустой: оптимистичный успех не засчитывается.
  assert.equal(harness.runtime.authenticated, false);
  assert.equal(harness.runtime.statusSnapshot().state, 'login_required');
});

test('неудачное уведомление не оставляет ссылку пригодной', async (t) => {
  const scenario = happyScenario({account: {account: null, requiresOpenaiAuth: true}});
  scenario.methods['account/login/start'].after = [
    {method: 'account/login/completed', params: {loginId: 'login-1', success: false, error: 'declined'}},
  ];
  scenario.methods['account/login/start'].afterDelayMs = 5;
  const harness = createRuntime({scenario});
  t.after(() => harness.cleanup());
  await harness.runtime.startLogin();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const status = harness.runtime.statusSnapshot();
  assert.equal(status.loginUrl, null);
  assert.equal(status.state, 'login_required');
});

test('незавершённый вход не переживает перезапуск', async (t) => {
  const harness = createRuntime({
    scenario: happyScenario({account: {account: null, requiresOpenaiAuth: true}}),
    loginTimeoutMs: 60_000,
  });
  t.after(() => harness.cleanup());
  await harness.runtime.startLogin();
  assert.equal(harness.store.readLogin().status, 'pending');
  // Повторная подготовка имитирует перезапуск процесса на том же томе.
  harness.runtime.prepare();
  assert.equal(harness.store.readLogin().status, 'interrupted');
});

test('вход по истечении срока отменяется', async (t) => {
  const harness = createRuntime({
    scenario: happyScenario({account: {account: null, requiresOpenaiAuth: true}}),
    loginTimeoutMs: 30,
  });
  t.after(() => harness.cleanup());
  await harness.runtime.startLogin();
  await new Promise((resolve) => setTimeout(resolve, 90));
  const status = harness.runtime.statusSnapshot();
  assert.equal(status.loginUrl, null);
  assert.equal(status.state, 'login_required');
  const cancel = harness.received().find((message) => message.method === 'account/login/cancel');
  assert.ok(cancel, 'просроченный вход отменён');
});
