'use strict';

/* Мост: личное напоминание от Хью (specs/083-project-chat-personal-reminders).
   Ровно один sendMessage в личный чат получателя тем же ботом; ни повтора неизвестного исхода,
   ни правки, ни закрепа, ни отправки в группу.
   node --test ops/chat/project-chat-bridge-personal.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createProjectChatBridge, AI_SIGNATURE, TEXT_PART } = require('./project-chat-bridge');
const { parseQuietHours } = require('./quiet-hours');

const CONTENT = 'http://content:8080';
const PREFIX = '/content/internal/project-chat';
const TG = '5001';
const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
const personalJob = (over = {}) => ({ id: 'personal:4', kind: 'personal', companyCode: 'palitra-love', chatId: TG, botId: '123',
  text: 'Напоминание по задаче №7 «Состав»\nПришлите состав.\nОт вашего ответа зависит: цена', authorType: 'assistant', authorName: 'Хью', ...over });
const delivered = (chatId = Number(TG), messageId = 9001) => ({ result: { message_id: messageId, chat: { id: chatId, type: 'private' } } });

function setup({ jobs = [], telegram = () => delivered(), token = '123:bot-token' } = {}) {
  const calls = { content: [], telegram: [] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/bot')) {
      const method = target.split('/').pop();
      calls.telegram.push({ method, body: options.body ? JSON.parse(options.body) : null });
      const outcome = telegram(method);
      if (outcome instanceof Error) throw outcome;
      if (outcome.broken) return { ok: true, status: 200, json: async () => { throw new Error('не JSON'); } };
      if (outcome.status && outcome.status >= 400) {
        return { ok: false, status: outcome.status, json: async () => ({ ok: false, error_code: outcome.status, description: outcome.description || 'ошибка' }) };
      }
      return json({ ok: true, result: outcome.result });
    }
    const route = target.slice(target.indexOf(PREFIX) + PREFIX.length);
    calls.content.push({ route: route.split('?')[0], query: Object.fromEntries(new URL(target).searchParams),
      body: options.body ? JSON.parse(options.body) : null });
    if (route.startsWith('/outbox')) return json({ jobs: jobs.length ? [jobs.shift()] : [] });
    if (route.startsWith('/acknowledge')) return json({ ok: true });
    return json({ error: 'нет маршрута' }, 404);
  };
  const bridge = createProjectChatBridge({ db: new DatabaseSync(':memory:'), contentUrl: CONTENT, apiKey: 'secret',
    telegramToken: token, legacyHandler: async () => {}, fetchImpl, quietHours: parseQuietHours({}),
    now: () => new Date('2026-10-02T09:00:00Z') });
  return { bridge, calls };
}
const acks = (calls) => calls.content.filter((c) => c.route === '/acknowledge').map((c) => c.body);

test('мост объявляет личные напоминания и отправляет ровно один sendMessage в личный чат получателя', async () => {
  const { bridge, calls } = setup({ jobs: [personalJob()] });
  await bridge.tick();
  const outbox = calls.content.filter((c) => c.route === '/outbox');
  assert.ok(outbox.length >= 1);
  assert.ok(outbox.every((c) => String(c.query.capabilities).split(',').includes('personal')));
  assert.deepEqual(calls.telegram.map((c) => c.method), ['sendMessage']);
  assert.deepEqual(calls.telegram[0].body, { chat_id: TG, text: `${AI_SIGNATURE}\n${personalJob().text}` });
  assert.deepEqual(acks(calls), [{ jobId: 'personal:4', ok: true, messageId: '9001', chatId: TG }]);
});

test('исход: 403 — видимый отказ получателя; сбой сети и ответ про другой чат — неизвестно, без повтора', async () => {
  const cases = [
    [{ status: 403, description: 'Forbidden: bot was blocked by the user' },
      { jobId: 'personal:4', ok: false, uncertain: false, retryable: false, forbidden: true, error: 'Telegram: 403 — Forbidden: bot was blocked by the user' }],
    [{ status: 403, description: "Forbidden: bot can't initiate conversation with a user" },
      { jobId: 'personal:4', ok: false, uncertain: false, retryable: false, forbidden: true, error: "Telegram: 403 — Forbidden: bot can't initiate conversation with a user" }],
    [{ status: 400, description: 'Bad Request: chat not found' },
      { jobId: 'personal:4', ok: false, uncertain: false, retryable: false, forbidden: false, error: 'Telegram: 400 — Bad Request: chat not found' }],
    [{ status: 429, description: 'Too Many Requests: retry after 5' },
      { jobId: 'personal:4', ok: false, uncertain: false, retryable: false, forbidden: false, error: 'Telegram: 429 — Too Many Requests: retry after 5' }],
    [{ status: 502, description: 'Bad Gateway' },
      { jobId: 'personal:4', ok: false, uncertain: true, retryable: false, error: 'Нет подтверждения отправки от Telegram; повтор не выполняется' }],
    [new Error('обрыв связи'), { jobId: 'personal:4', ok: false, uncertain: true, retryable: false, error: 'Нет подтверждения отправки от Telegram; повтор не выполняется' }],
    [{ broken: true }, { jobId: 'personal:4', ok: false, uncertain: true, retryable: false, error: 'Нет подтверждения отправки от Telegram; повтор не выполняется' }],
    [{ result: { chat: { id: Number(TG) } } }, { jobId: 'personal:4', ok: false, uncertain: true, retryable: false, error: 'Нет подтверждения отправки от Telegram; повтор не выполняется' }],
    [delivered(-100777000111), { jobId: 'personal:4', ok: false, uncertain: true, retryable: false, error: 'Telegram не подтвердил доставку именно этому получателю' }],
  ];
  for (const [outcome, expected] of cases) {
    const { bridge, calls } = setup({ jobs: [personalJob()], telegram: () => outcome });
    await bridge.tick();
    await bridge.tick();
    assert.deepEqual(calls.telegram.map((c) => c.method), ['sendMessage'], `ровно одна попытка: ${JSON.stringify(outcome).slice(0, 60)}`);
    assert.deepEqual(acks(calls), [expected], JSON.stringify(outcome).slice(0, 60));
  }
});

test('другой бот, группа вместо человека, пустой или длинный текст — до Telegram не доходит', async () => {
  const long = 'x'.repeat(TEXT_PART - AI_SIGNATURE.length);
  for (const [job, token] of [[personalJob({ botId: '999' }), '123:bot-token'], [personalJob(), 'не-токен'],
    [personalJob({ chatId: '-100777000111' }), '123:bot-token'], [personalJob({ chatId: 'daria' }), '123:bot-token'],
    [personalJob({ text: '  ' }), '123:bot-token'], [personalJob({ text: long }), '123:bot-token']]) {
    const { bridge, calls } = setup({ jobs: [job], token });
    await bridge.tick();
    assert.equal(calls.telegram.length, 0, JSON.stringify(job).slice(0, 80));
    const [ack] = acks(calls);
    assert.equal(ack.ok, false);
    assert.equal(ack.uncertain, false);
  }
  // Задание без номера personal:N не исполняется и не квитируется.
  for (const job of [personalJob({ id: '4' }), personalJob({ id: 4 }), personalJob({ id: 'personal:x' })]) {
    const { bridge, calls } = setup({ jobs: [job] });
    await bridge.tick();
    assert.equal(calls.telegram.length, 0);
    assert.deepEqual(acks(calls), []);
  }
  // Ровно одна часть — уходит.
  const { bridge, calls } = setup({ jobs: [personalJob({ text: long.slice(1) })] });
  await bridge.tick();
  assert.deepEqual(calls.telegram.map((c) => c.method), ['sendMessage']);
});

test('личное напоминание не правит, не закрепляет, не удаляет и не пишет в группу', async () => {
  for (const outcome of [delivered(), { status: 403 }, new Error('обрыв'), { status: 500 }]) {
    const { bridge, calls } = setup({ jobs: [personalJob(), personalJob({ id: 'personal:5' })], telegram: () => outcome });
    await bridge.tick();
    for (const call of calls.telegram) {
      assert.equal(call.method, 'sendMessage');
      assert.equal(call.body.chat_id, TG);
    }
  }
});
