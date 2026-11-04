'use strict';

/* Мост: правка отправленного сообщения Хью (specs/082-project-chat-reviewed-edit).
   Ровно один editMessageText тем же ботом; ни отправки, ни закрепа, ни удаления.
   Только встроенные модули Node: node --test ops/chat/project-chat-bridge-edit.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createProjectChatBridge, AI_SIGNATURE, TEXT_PART } = require('./project-chat-bridge');
const { parseQuietHours } = require('./quiet-hours');

const CONTENT = 'http://content:8080';
const PREFIX = '/content/internal/project-chat';
const GROUP = '-100777000111';
const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
const editJob = (over = {}) => ({ id: 'edit:7', kind: 'edit', companyCode: 'palitra-love', chatId: GROUP,
  telegramMessageId: '136', text: 'Сводка — обновлено', authorType: 'assistant', authorName: 'Хью', attempt: 1, ...over });
// Ответ Bot API на editMessageText: отредактированное сообщение той же группы.
const edited = (messageId = 136, chatId = Number(GROUP)) => ({ result: { message_id: messageId, chat: { id: chatId } } });

function setup({ jobs = [], telegram = () => edited() } = {}) {
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
    telegramToken: '123:bot-token', legacyHandler: async () => {}, fetchImpl, quietHours: parseQuietHours({}),
    now: () => new Date('2026-10-02T12:00:00Z') });
  return { bridge, calls };
}
const acks = (calls) => calls.content.filter((c) => c.route === '/acknowledge').map((c) => c.body);

test('мост объявляет правку и выполняет ровно один editMessageText того же сообщения', async () => {
  const { bridge, calls } = setup({ jobs: [editJob()] });
  await bridge.tick();
  const outbox = calls.content.filter((c) => c.route === '/outbox');
  assert.ok(outbox.length >= 1);
  assert.ok(outbox.every((c) => String(c.query.capabilities).split(',').includes('edit')), 'каждый запрос очереди объявляет правку');
  assert.deepEqual(calls.telegram.map((c) => c.method), ['editMessageText']);
  assert.deepEqual(calls.telegram[0].body, { chat_id: GROUP, message_id: 136, text: `${AI_SIGNATURE}\nСводка — обновлено` });
  assert.deepEqual(acks(calls), [{ jobId: 'edit:7', ok: true, editedMessageId: '136', chatId: GROUP }]);
});

test('«message is not modified» — успех; другие отказы и неизвестный исход — не успех', async () => {
  const cases = [
    [{ status: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' },
      { jobId: 'edit:7', ok: true, notModified: true, editedMessageId: '136', chatId: GROUP }],
    [{ status: 400, description: 'Bad Request: message to edit not found' },
      { jobId: 'edit:7', ok: false, uncertain: false, retryable: false, error: 'Telegram: 400 — Bad Request: message to edit not found' }],
    [{ status: 429, description: 'Too Many Requests: retry after 5' },
      { jobId: 'edit:7', ok: false, uncertain: false, retryable: true, error: 'Telegram: 429 — Too Many Requests: retry after 5' }],
    [{ status: 502, description: 'Bad Gateway' },
      { jobId: 'edit:7', ok: false, uncertain: true, retryable: true, error: 'Нет подтверждения правки от Telegram' }],
    [new Error('обрыв связи'), { jobId: 'edit:7', ok: false, uncertain: true, retryable: true, error: 'Нет подтверждения правки от Telegram' }],
    [{ broken: true }, { jobId: 'edit:7', ok: false, uncertain: true, retryable: true, error: 'Нет подтверждения правки от Telegram' }],
    // Ответ про другое сообщение или другую группу — не подтверждение (ложный успех).
    [edited(137), { jobId: 'edit:7', ok: false, uncertain: true, retryable: true, error: 'Telegram не подтвердил правку именно этого сообщения' }],
    [edited(136, -100999), { jobId: 'edit:7', ok: false, uncertain: true, retryable: true, error: 'Telegram не подтвердил правку именно этого сообщения' }],
    [{ result: true }, { jobId: 'edit:7', ok: false, uncertain: true, retryable: true, error: 'Telegram не подтвердил правку именно этого сообщения' }],
  ];
  for (const [outcome, expected] of cases) {
    const { bridge, calls } = setup({ jobs: [editJob()], telegram: () => outcome });
    await bridge.tick();
    assert.deepEqual(calls.telegram.map((c) => c.method), ['editMessageText'], JSON.stringify(outcome));
    assert.deepEqual(acks(calls), [expected], JSON.stringify(outcome));
  }
});

test('некорректное или слишком длинное задание правки до Telegram не доходит', async () => {
  const long = 'x'.repeat(TEXT_PART - AI_SIGNATURE.length);   // подпись + \n + текст = TEXT_PART + 1
  // Правка без номера edit:N не исполняется и не квитируется: числовой номер принадлежит обычной отправке.
  for (const job of [editJob({ id: 'edit:x' }), editJob({ id: '7' }), editJob({ id: 7 })]) {
    const { bridge, calls } = setup({ jobs: [job] });
    await bridge.tick();
    assert.equal(calls.telegram.length, 0);
    assert.deepEqual(acks(calls), []);
  }
  for (const job of [editJob({ chatId: 'группа' }), editJob({ telegramMessageId: '13 6' }),
    editJob({ telegramMessageId: undefined }), editJob({ text: '   ' }), editJob({ text: 7 }), editJob({ text: long })]) {
    const { bridge, calls } = setup({ jobs: [job] });
    await bridge.tick();
    assert.equal(calls.telegram.length, 0, JSON.stringify(job).slice(0, 80));
    const [ack] = acks(calls);
    assert.equal(ack.ok, false);
    assert.equal(ack.retryable, false);
  }
  // Ровно на границе одной части — уходит.
  const { bridge, calls } = setup({ jobs: [editJob({ text: long.slice(1) })] });
  await bridge.tick();
  assert.deepEqual(calls.telegram.map((c) => c.method), ['editMessageText']);
});

test('правка никогда не отправляет, не закрепляет и не удаляет сообщения', async () => {
  const outcomes = [edited(), { status: 400, description: 'message is not modified' }, new Error('обрыв'), { status: 500 }];
  for (const outcome of outcomes) {
    const { bridge, calls } = setup({ jobs: [editJob(), editJob({ id: 'edit:8' })], telegram: () => outcome });
    await bridge.tick();
    for (const call of calls.telegram) assert.equal(call.method, 'editMessageText');
    assert.ok(!calls.telegram.some((c) => /^(send|copy|forward|pin|unpin|delete)/i.test(c.method)));
  }
});

test('обычная отправка комнаты не изменилась: sendMessage частями и без правки', async () => {
  const { bridge, calls } = setup({ jobs: [{ id: 5, companyCode: 'palitra-love', chatId: GROUP, messageId: 9, attempt: 1,
    text: 'y'.repeat(TEXT_PART), authorType: 'assistant', authorName: 'Хью', attachments: [] }],
    telegram: (method) => ({ result: { message_id: method === 'sendMessage' ? 501 : 0 } }) });
  await bridge.tick();
  assert.deepEqual(calls.telegram.map((c) => c.method), ['sendMessage', 'sendMessage'], 'подпись + текст длиннее одной части');
  assert.equal(acks(calls)[0].ok, true);
});
