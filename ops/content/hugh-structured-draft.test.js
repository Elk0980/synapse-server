'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHughFallback } = require('./hugh-fallback');
const { createHughBudget } = require('./hugh-budget');
const { createMediaMentorSuggest } = require('./media-mentor-suggest');

function setup(t, provider, output = { choices: [{ message: { content: '[]' } }] }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const calls = [];
  const fallback = createHughFallback({ db, env: {},
    providerStore: { available: true, runtimeProviders: () => [{
      url: 'https://example.test/v1', secret: 'test-secret', timeoutMs: 10000, ...provider,
    }] },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => output };
    },
  });
  return { db, calls, fallback };
}
const payload = (profile) => JSON.stringify({ system: 'JSON draft', messages: [], responseProfile: profile });

test('структурированный черновик отключает thinking только у поддержанного DeepSeek', async t => {
  const { calls, fallback } = setup(t, { name: 'deepseek', model: 'deepseek-flash' });
  await fallback.reply(payload('structured-draft'));
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.equal(calls[0].max_tokens, 1200);
  await fallback.reply(payload(undefined));
  assert.equal(calls[1].thinking, undefined);
});

test('GLM 5.3 сохраняет обязательное thinking, снижая effort для черновика', async t => {
  const { calls, fallback } = setup(t, { name: 'zai', model: 'glm-5.3-flash' });
  await fallback.reply(payload('structured-draft'));
  assert.deepEqual(calls[0].thinking, { type: 'enabled' });
  assert.equal(calls[0].reasoning_effort, 'low');
});

test('чужой контракт и неизвестная модель не получают специальные параметры', async t => {
  for (const provider of [{ name: 'openrouter', model: 'deepseek-flash' },
    { name: 'deepseek', model: 'unknown-model' }]) {
    const { calls, fallback } = setup(t, provider);
    await fallback.reply(payload('structured-draft'));
    assert.equal(calls[0].thinking, undefined);
    assert.equal(calls[0].reasoning_effort, undefined);
  }
});

test('потолок провайдера ограничивает фактический запрос и бронь, общий потолок не растёт', async t => {
  const { calls, fallback } = setup(t, { name: 'deepseek', model: 'deepseek-flash', maxOutputTokens: 300 });
  await fallback.reply(payload('structured-draft'));
  assert.equal(calls[0].max_tokens, 300);
  const second = setup(t, { name: 'zai', model: 'glm-5.3-flash', maxOutputTokens: 5000 });
  await second.fallback.reply(payload('structured-draft'));
  assert.equal(second.calls[0].max_tokens, 1200);
});

test('резерв возвращает тот потолок, который включён в стоимость', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const budget = createHughBudget({ db, env: { HUGH_FALLBACK_BUDGET_USD: '1',
    HUGH_FALLBACK_TEST_USD_PER_1K_PROMPT: '0', HUGH_FALLBACK_TEST_USD_PER_1K_COMPLETION: '1' } });
  const held = budget.reserve('test', { promptBytes: 0, maxOutputTokens: 64 });
  assert.equal(held.allowed, true);
  assert.equal(held.maxOutputTokens, 64);
  assert.equal(held.estimateMicroUsd, 64000);
});

test('рассуждение без финального текста не становится ответом и не запускает повтор', async t => {
  const { calls, fallback } = setup(t, { name: 'deepseek', model: 'deepseek-flash' }, {
    choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'private internal text' } }],
  });
  await assert.rejects(fallback.reply(payload('structured-draft')), /недоступны/);
  assert.equal(calls.length, 1);
  const status = fallback.status();
  assert.match(status.providers[0].lastError, /исчерпал потолок/);
  assert.doesNotMatch(JSON.stringify(status), /private internal text/);
});

test('предложение наставника использует экономный профиль и сохраняет реальный ответ', async t => {
  const content = JSON.stringify([{date: '2026-09-24', platform: 'telegram', format: 'post',
    role: 'reach', topic: 'Вопрос клиента', hook: 'Что проверить?', assetId: '', mentorNote: 'Попросите пример.'}]);
  const { calls, fallback } = setup(t, { name: 'deepseek', model: 'deepseek-flash' },
    { choices: [{ message: { content } }], model: 'deepseek-flash' });
  const suggest = createMediaMentorSuggest({ ask: body => fallback.reply(body) });
  const result = await suggest.suggest({platforms: ['telegram']}, {startDate: '2026-09-24', days: 7});
  assert.equal(result.status, 'ok');
  assert.equal(result.items[0].topic, 'Вопрос клиента');
  assert.equal(result.capabilities.saved, false);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
});
