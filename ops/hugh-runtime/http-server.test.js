'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {createHttpServer} = require('./http-server');
const {createJobStore} = require('./job-store');
const {LIMITS} = require('./limits');
const {RuntimeError, unavailable} = require('./errors');
const {tempDir, removeDir, silentLogger} = require('./test-support/harness');

// Ключ обязан быть ASCII: заголовки HTTP — ByteString, кириллица в них запрещена стандартом.
const KEY = 'hugh-runtime-test-key-0123456789';

function stubRuntime(overrides = {}) {
  const calls = {status: 0, login: 0, reply: []};
  return {
    calls,
    statusSnapshot: () => {
      calls.status += 1;
      return {connected: true, authenticated: true, provider: 'codex', model: 'gpt-test', state: 'connected', loginUrl: null, userCode: null, error: null, errorCode: null, replyEnabled: true, version: '0.154.0', safety: {toolIsolationVerified: true, reason: 'proof_ok'}};
    },
    startLogin: async () => {
      calls.login += 1;
      return {state: 'connecting', loginUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234'};
    },
    reply: async (payload) => {
      calls.reply.push(payload);
      return {text: 'ответ', model: 'gpt-test'};
    },
    ...overrides,
  };
}

async function withServer(runtime, run) {
  const dir = tempDir('hugh-http-');
  const store = createJobStore(path.join(dir, 'state.sqlite'));
  const server = createHttpServer({runtime, store, apiKey: KEY, logger: silentLogger});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({base, store});
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await removeDir(dir);
  }
}

const body = (overrides = {}) => ({
  jobId: 'job-1',
  companyCode: 'palitra',
  system: 'Отвечай кратко.',
  messages: [{role: 'user', content: 'Привет'}],
  ...overrides,
});

test('пустой серверный ключ запрещает запуск', () => {
  assert.throws(() => createHttpServer({runtime: stubRuntime(), store: {}, apiKey: '  '}), /CHAT_API_KEY/);
});

test('оба поддерживаемых заголовка работают', async () => {
  const runtime = stubRuntime();
  await withServer(runtime, async ({base}) => {
    const bearer = await fetch(`${base}/status`, {headers: {authorization: `Bearer ${KEY}`}});
    assert.equal(bearer.status, 200);
    const direct = await fetch(`${base}/status`, {headers: {'x-api-key': KEY}});
    assert.equal(direct.status, 200);
    const both = await fetch(`${base}/status`, {headers: {authorization: `Bearer ${KEY}`, 'x-api-key': KEY}});
    assert.equal(both.status, 200);
  });
});

test('отсутствующий, неверный и противоречивый ключ отклоняются до чтения тела', async () => {
  const runtime = stubRuntime();
  await withServer(runtime, async ({base}) => {
    const none = await fetch(`${base}/reply`, {method: 'POST', body: JSON.stringify(body())});
    assert.equal(none.status, 401);
    const wrong = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': 'another-key'}, body: JSON.stringify(body())});
    assert.equal(wrong.status, 401);
    const malformed = await fetch(`${base}/status`, {headers: {authorization: KEY}});
    assert.equal(malformed.status, 401);
    const conflicting = await fetch(`${base}/status`, {headers: {authorization: `Bearer ${KEY}`, 'x-api-key': 'another-key'}});
    assert.equal(conflicting.status, 401);
    assert.equal((await conflicting.json()).errorCode, 'AUTH_CONFLICT');
    assert.equal(runtime.calls.reply.length, 0, 'модель не вызывалась');
    assert.equal(runtime.calls.status, 0, 'состояние не читалось');
  });
});

test('/status отдаёт точные границы', async () => {
  await withServer(stubRuntime(), async ({base}) => {
    const response = await fetch(`${base}/status`, {headers: {'x-api-key': KEY}});
    const payload = await response.json();
    assert.deepEqual(payload.limits, LIMITS);
    assert.equal(payload.provider, 'codex');
  });
});

test('/login принимает только пустое тело и не берёт ссылки от клиента', async () => {
  const runtime = stubRuntime();
  await withServer(runtime, async ({base}) => {
    const ok = await fetch(`${base}/login`, {method: 'POST', headers: {'x-api-key': KEY}, body: '{}'});
    assert.equal(ok.status, 200);
    const bad = await fetch(`${base}/login`, {
      method: 'POST',
      headers: {'x-api-key': KEY},
      body: JSON.stringify({loginUrl: 'https://evil.example'}),
    });
    assert.equal(bad.status, 400);
    assert.equal(runtime.calls.login, 1);
  });
});

test('/reply повторяет сохранённый ответ и не запускает вторую генерацию', async () => {
  const runtime = stubRuntime();
  await withServer(runtime, async ({base}) => {
    const first = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {text: 'ответ', provider: 'codex', model: 'gpt-test', reused: false});
    const second = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    assert.equal((await second.json()).reused, true);
    assert.equal(runtime.calls.reply.length, 1);
  });
});

test('тот же jobId с другим содержимым — конфликт 409', async () => {
  await withServer(stubRuntime(), async ({base}) => {
    await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    const changed = await fetch(`${base}/reply`, {
      method: 'POST',
      headers: {'x-api-key': KEY},
      body: JSON.stringify(body({messages: [{role: 'user', content: 'Другое'}]})),
    });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).errorCode, 'JOB_CONFLICT');
  });
});

test('ошибка рантайма отдаётся безопасным кодом без деталей Codex', async () => {
  const secret = 'sk-канарейка-не-должна-утечь';
  const runtime = stubRuntime({
    reply: async () => {
      throw unavailable('TOOL_ISOLATION_UNVERIFIED', 'Изоляция инструментов ещё не подтверждена проверкой');
    },
  });
  runtime.calls.reply = [];
  await withServer(runtime, async ({base}) => {
    const response = await fetch(`${base}/reply`, {
      method: 'POST',
      headers: {'x-api-key': KEY},
      body: JSON.stringify(body({system: `Отвечай кратко. ${secret}`})),
    });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(JSON.parse(text).errorCode, 'TOOL_ISOLATION_UNVERIFIED');
    assert.ok(!text.includes(secret));
  });
});

test('внутреннее исключение не раскрывает стек', async () => {
  const runtime = stubRuntime({
    reply: async () => {
      throw new Error('внутренняя деталь /data/codex/auth.json');
    },
  });
  await withServer(runtime, async ({base}) => {
    const response = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(JSON.parse(text).errorCode, 'INTERNAL_ERROR');
    assert.ok(!text.includes('auth.json'));
  });
});

test('слишком большое тело и неизвестные маршруты', async () => {
  await withServer(stubRuntime(), async ({base}) => {
    const huge = 'я'.repeat(LIMITS.maxBodyBytes);
    const large = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body({system: huge}))})
      .catch(() => ({status: 413}));
    assert.ok(large.status === 413 || large.status === 400);
    const missing = await fetch(`${base}/nope`, {headers: {'x-api-key': KEY}});
    assert.equal(missing.status, 404);
    const method = await fetch(`${base}/status`, {method: 'POST', headers: {'x-api-key': KEY}});
    assert.equal(method.status, 405);
  });
});

test('занятый рантайм отвечает 429 с Retry-After', async () => {
  const runtime = stubRuntime({
    reply: async () => {
      throw new RuntimeError(429, 'BUSY', 'Рантайм занят другим заданием', {retryAfterSeconds: 5});
    },
  });
  await withServer(runtime, async ({base}) => {
    const response = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal((await response.json()).retryAfter, 5);
  });
});

test('лимит подписки не сжигает попытку: тот же jobId повторяется без конфликта', async () => {
  let limited = true;
  const runtime = stubRuntime({
    reply: async () => {
      if (limited) throw new RuntimeError(429, 'RATE_LIMITED', 'Лимит подписки исчерпан, ответ будет позже', {retryAfterSeconds: 90});
      return {text: 'ответ после ожидания', model: 'gpt-test'};
    },
  });
  await withServer(runtime, async ({base, store}) => {
    const waiting = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    assert.equal(waiting.status, 429);
    assert.equal(waiting.headers.get('retry-after'), '90');
    const payload = await waiting.json();
    assert.equal(payload.errorCode, 'RATE_LIMITED');
    assert.equal(payload.retryAfter, 90);
    // Аренда снята: следа неудачной попытки не осталось.
    assert.equal(store.get('palitra', 'job-1'), null);

    limited = false;
    const retry = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).text, 'ответ после ожидания');
  });
});

test('постоянная ошибка остаётся записанной как неудача', async () => {
  const runtime = stubRuntime({
    reply: async () => {
      throw unavailable('EMPTY_REPLY', 'Модель не вернула итоговый ответ');
    },
  });
  await withServer(runtime, async ({base, store}) => {
    const response = await fetch(`${base}/reply`, {method: 'POST', headers: {'x-api-key': KEY}, body: JSON.stringify(body())});
    assert.equal(response.status, 503);
    const row = store.get('palitra', 'job-1');
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'EMPTY_REPLY');
  });
});
