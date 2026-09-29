'use strict';
/* Клиент CRM → chat: только офлайн, fetch подменён. Ключи и адреса вымышленные. */
const test = require('node:test'), assert = require('node:assert/strict');
const { createTelegramChannelStatsClient } = require('./telegram-channel-stats');

const KEY = 'fixture-service-key';
const ok = (over = {}) => ({ companyCode: 'alvi', accountRef: '@demo_channel', metric: 'followers',
  value: 136, observedAt: '2026-09-29T10:00:00.000Z', source: 'getChatMemberCount', ...over });
function client({ body = ok(), status = 200, baseUrl = 'http://chat:8080', apiKey = KEY, impl } = {}) {
  const calls = [];
  const fetchImpl = impl || (async (href, options) => {
    calls.push({ href, options });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  });
  return { api: createTelegramChannelStatsClient({ baseUrl, apiKey, fetchImpl }), calls };
}
const rejects = async (promise, code) => {
  try { await promise; } catch (error) { assert.equal(error.code, code, error.message); return error; }
  assert.fail('ожидался отказ ' + code);
};

test('запрос строится сервером: фиксированный адрес, только код компании, GET без редиректа', async () => {
  const f = client();
  const out = await f.api.channelMembers('ALVI');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].href, 'http://chat:8080/internal/telegram/channel-members?companyCode=alvi');
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(f.calls[0].options.redirect, 'error', 'за редиректом с межсервисным ключом не идём');
  assert.equal(f.calls[0].options.headers['x-api-key'], KEY);
  assert.deepEqual(out, { companyCode: 'alvi', accountRef: '@demo_channel', value: 136,
    observedAt: '2026-09-29T10:00:00.000Z', source: 'getChatMemberCount' });
});

test('без адреса или ключа запрос не делается вовсе', async () => {
  for (const options of [{ baseUrl: '' }, { apiKey: '' }, { baseUrl: 'ftp://chat' }]) {
    const f = client({ ...options, impl: async () => { assert.fail('сети быть не должно'); } });
    assert.equal(f.api.ready, false);
    await rejects(f.api.channelMembers('alvi'), 'NOT_CONFIGURED');
  }
  const bad = client({ impl: async () => { assert.fail('сети быть не должно'); } });
  await rejects(bad.api.channelMembers('не код'), 'VALIDATION_ERROR');
});

test('отказы сервиса объясняются общими словами, без ключа и адреса с ключом', async () => {
  for (const [status, code] of [[401, 'REJECTED'], [403, 'REJECTED'], [404, 'REJECTED'], [405, 'REJECTED'], [409, 'REJECTED'], [408, 'UNAVAILABLE'], [429, 'UNAVAILABLE'], [502, 'UNAVAILABLE'], [503, 'UNAVAILABLE'], [504, 'UNAVAILABLE']]) {
    const error = await rejects(client({ status, body: { error: `ключ ${KEY} не принят` } }).api.channelMembers('alvi'), code);
    assert.doesNotMatch(error.message, new RegExp(KEY), 'ключ наружу не выходит');
    assert.doesNotMatch(error.message, /chat:8080/, 'адрес сервиса наружу не выходит');
  }
  await rejects(client({ impl: async () => { throw new Error('ECONNREFUSED http://chat:8080'); } }).api.channelMembers('alvi'), 'UNAVAILABLE');
  await rejects(client({ body: 'не json' }).api.channelMembers('alvi'), 'BAD_RESPONSE');
  await rejects(client({ body: 'x'.repeat(70000) }).api.channelMembers('alvi'), 'BAD_RESPONSE');
});

test('чужая компания, отсутствующий канал и нецелое число не принимаются', async () => {
  await rejects(client({ body: ok({ companyCode: 'avokado' }) }).api.channelMembers('alvi'), 'COMPANY_MISMATCH');
  await rejects(client({ body: ok({ accountRef: 'demo_channel' }) }).api.channelMembers('alvi'), 'BAD_RESPONSE');
  await rejects(client({ body: ok({ value: 12.5 }) }).api.channelMembers('alvi'), 'BAD_RESPONSE');
  await rejects(client({ body: ok({ value: -1 }) }).api.channelMembers('alvi'), 'BAD_RESPONSE');
  await rejects(client({ body: ok({ value: null }) }).api.channelMembers('alvi'), 'BAD_RESPONSE');
  // Настоящий ноль — это значение.
  assert.equal((await client({ body: ok({ value: 0 }) }).api.channelMembers('alvi')).value, 0);
});

/* Предел ответа — байты, проверяется по мере чтения, поток отменяется до разбора JSON. */
const { TELEGRAM_STATS_MAX_BYTES } = require('./telegram-channel-stats');
const stream = (parts, state = {}) => {
  let index = 0;
  return { ok: true, status: 200, text: async () => parts.join(''), body: { getReader: () => ({
    read: async () => { state.reads = (state.reads || 0) + 1;
      if (index >= parts.length) return { done: true, value: undefined };
      return { done: false, value: Buffer.from(parts[index++], 'utf8') }; },
    cancel: async () => { state.cancelled = true; },
  }) } };
};
const streamed = (parts, state) => createTelegramChannelStatsClient({ baseUrl: 'http://chat:8080', apiKey: KEY,
  fetchImpl: async () => stream(parts, state) });

test('многобайтный ответ в пределе символов по байтам отклоняется', async () => {
  const long = JSON.stringify({ ...ok(), note: 'я'.repeat(40000) });
  assert.ok(long.length < TELEGRAM_STATS_MAX_BYTES, 'по символам такой ответ прошёл бы');
  assert.ok(Buffer.byteLength(long, 'utf8') > TELEGRAM_STATS_MAX_BYTES);
  const state = {};
  await rejects(streamed([long], state).channelMembers('alvi'), 'BAD_RESPONSE');
  assert.equal(state.cancelled, true, 'поток отменён');
  // Тот же ответ без потока тоже отклоняется: длина считается в байтах.
  await rejects(client({ body: JSON.parse(long) }).api.channelMembers('alvi'), 'BAD_RESPONSE');
});

test('ответ в мегабайты отменяется на превышении, а не после полной загрузки', async () => {
  const state = {};
  const parts = Array.from({ length: 640 }, () => 'x'.repeat(8 * 1024)); // около 5 МиБ
  await rejects(streamed(parts, state).channelMembers('alvi'), 'BAD_RESPONSE');
  assert.equal(state.cancelled, true);
  assert.ok(state.reads <= 10, `прочитано кусков: ${state.reads} — до конца ответ не дочитывался`);
});

test('корректный ответ читается потоком, разбор идёт после проверки предела', async () => {
  const state = {};
  const body = JSON.stringify(ok());
  const out = await streamed([body.slice(0, 20), body.slice(20)], state).channelMembers('alvi');
  assert.equal(out.value, 136);
  assert.equal(state.cancelled, undefined);
});
