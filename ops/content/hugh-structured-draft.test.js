'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHughFallback } = require('./hugh-fallback');
const { createHughBudget } = require('./hugh-budget');
const { createMediaMentorSuggest } = require('./media-mentor-suggest');
const { validateReplyPayload } = require('../hugh-runtime/limits');
const { createProjectChat } = require('./project-chat');
const { createAuthStore } = require('./auth-store');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

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

test('реальный контракт основного рантайма принимает запрос наставника с областью и jobId', async t => {
  const db = new DatabaseSync(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-runtime-contract-'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const hash = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
  const authStore = createAuthStore(db, `owner:owner:${hash}`);
  const seen = [];
  const chat = createProjectChat({db, authStore, assetsDir: dir,
    runnerUrl: 'http://runtime.test', chatApiKey: 'test-only',
    requireSession: () => null, requireCsrf: () => {}, sendJson: () => {}, readBody: async () => ({}),
    fetchImpl: async (_url, options) => {
      const raw = JSON.parse(options.body);
      seen.push(validateReplyPayload(raw));
      assert.equal(raw.responseProfile, undefined);
      return {ok: true, status: 200, json: async () => ({text: JSON.stringify([
        {date:'2026-09-24', platform:'telegram', format:'post', role:'reach', topic:'Тема'}
      ])})};
    }, fallback: {env: {}}});
  const suggest = createMediaMentorSuggest({ask: body => chat.askHugh(body)});
  for (const companyCode of ['taisabai', 'palitra']) {
    const result = await suggest.suggest({platforms: ['telegram'], pains: Array(30).fill('вопрос '.repeat(40))},
      {startDate:'2026-09-24',days:7}, {companyCode,userId:1,audience:'owner-private'});
    assert.equal(result.status, 'ok');
  }
  assert.deepEqual(seen.map(item => item.companyCode), ['taisabai','palitra']);
  assert.equal(seen[0].audience, 'owner-private');
  assert.notEqual(seen[0].jobId, seen[1].jobId);
  assert.ok(seen[0].messages.length > 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_messages').get().n, 0);
});
