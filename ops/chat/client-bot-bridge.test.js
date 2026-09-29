'use strict';

/* Транспорт клиентского бота Palitra: только личные чаты, своя очередь и своя отметка опроса,
   вложения без утечки токена, части доставки без повторов неизвестного исхода.
   Только встроенные модули Node: node --test ops/chat/client-bot-bridge.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { createClientBotBridge } = require('./client-bot-bridge');
const { createProjectChatBridge } = require('./project-chat-bridge');
const { parseQuietHours } = require('./quiet-hours');

const TOKEN = '123456:client-bot-token';
const CONTENT = 'http://content:8080';
const PREFIX = '/content/internal/client-bot';
const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
const DAY = () => new Date('2026-09-29T09:00:00Z');       // 12:00 МСК — не тихие часы

const BOT_NAME = 'palitra_love_orders_bot';
function setup({ telegram = () => ({ result: { message_id: 500 } }), content = null, db = new DatabaseSync(':memory:'), now = DAY,
  file = Buffer.from('OggS-voice'), maxFile = 1024, botKey = 'palitra', token = TOKEN, webhookSecret = 'hook-secret',
  me = { id: 123456, is_bot: true, username: BOT_NAME }, expectedUsername = BOT_NAME, limits = {} } = {}) {
  const calls = { content: [], telegram: [], files: [] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/file/')) {
      calls.files.push(target);
      return { ok: true, status: 200, body: Readable.from([file]) };
    }
    if (target.startsWith('https://api.telegram.org/bot')) {
      const method = target.split('/').pop();
      const body = JSON.parse(options.body);
      calls.telegram.push({ method, body, token: target.slice('https://api.telegram.org/bot'.length).split('/')[0] });
      // getMe отвечает отдельно: мост проверяет, к какому боту относится токен, до любой работы.
      if (method === 'getMe') return me instanceof Error ? json({ ok: false, description: 'Unauthorized' }, 401) : json({ ok: true, result: me });
      const outcome = telegram(method, body, calls.telegram.filter((call) => call.method !== 'getMe').length);
      if (outcome instanceof Error) throw outcome;
      if (outcome.broken) return { ok: true, status: 200, json: async () => { throw new Error('не JSON'); } };
      if (outcome.status && outcome.status >= 400) {
        return { ok: false, status: outcome.status, json: async () => (outcome.status >= 500 ? { ok: false } : { ok: false, description: outcome.description || 'ошибка' }) };
      }
      return json({ ok: true, result: outcome.result ?? { message_id: 500 } });
    }
    const parsed = new URL(target);
    const route = parsed.pathname.slice(PREFIX.length);
    const body = options.body === undefined ? null : Buffer.isBuffer(options.body) ? options.body : JSON.parse(options.body);
    calls.content.push({ route, query: Object.fromEntries(parsed.searchParams), body, headers: options.headers, url: target });
    if (content) { const custom = content(route, body, parsed); if (custom) return custom; }
    if (route === '/receive') return json({ ok: true, downloads: [] });
    if (route === '/outbox') return json({ jobs: [] });
    return json({ ok: true });
  };
  const bridge = createClientBotBridge({ db, botKey, token, expectedUsername, contentUrl: CONTENT, apiKey: 'service-key', webhookSecret, fetchImpl,
    quietHours: parseQuietHours({}), now, maxFile, limits, log: { warn() {}, error() {} } });
  // Счётчики Telegram в тестах не учитывают служебные getMe.
  const sent = () => calls.telegram.filter((call) => call.method !== 'getMe');
  return { db, bridge, calls, sent };
}
const privateMessage = (updateId, from, text, extra = {}) => ({ update_id: updateId,
  message: { message_id: updateId * 10, date: 1790000000, chat: { id: from, type: 'private' }, from: { id: from, first_name: 'Анна' }, text, ...extra } });
const routes = (calls) => calls.content.map((call) => call.route);

test('в очередь попадают только личные сообщения, правки и нажатия кнопок; повтор update_id — одна запись', () => {
  const { db, bridge } = setup();
  assert.equal(bridge.enqueue(privateMessage(1, 900, 'Привет')), true);
  assert.equal(bridge.enqueue(privateMessage(1, 900, 'Привет')), true);
  assert.equal(bridge.enqueue({ update_id: 2, edited_message: { chat: { id: 900, type: 'private' }, message_id: 10, from: { id: 900 } } }), true);
  assert.equal(bridge.enqueue({ update_id: 3, callback_query: { id: 'q', from: { id: 900 }, data: 'x', message: { message_id: 4, chat: { id: 900, type: 'private' } } } }), true);
  assert.equal(bridge.enqueue({ update_id: 4, message: { chat: { id: -1001, type: 'supergroup' }, text: 'группа' } }), false);
  assert.equal(bridge.enqueue({ update_id: 5, channel_post: { chat: { id: -100, type: 'channel' } } }), false);
  assert.equal(bridge.enqueue({ update_id: 6, my_chat_member: {} }), false);
  assert.throws(() => bridge.enqueue({ update_id: 1.5 }), /Некорректный номер/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM client_bot_inbox').get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='project_telegram_inbox'").get().n, 0, 'таблицы общего чата не создаются');
});

test('отметки getUpdates двух ботов независимы: клиентский бот не сдвигает бот Synapse и наоборот', async () => {
  const db = new DatabaseSync(':memory:');
  const project = createProjectChatBridge({ db, contentUrl: CONTENT, apiKey: 'k', telegramToken: 'bot-synapse', legacyHandler: async () => {},
    fetchImpl: async () => json({}), quietHours: parseQuietHours({}), now: DAY });
  const palitra = setup({ db, telegram: (method) => (method === 'getUpdates'
    ? { result: [privateMessage(41, 900, 'Привет'), { update_id: 42, message: { chat: { id: -5, type: 'group' }, text: 'группа' } }] }
    : { result: true }) });
  const other = setup({ db, botKey: 'avokado', token: '999:other' });
  project.saveOffset(1000);
  palitra.bridge.saveOffset(7);
  assert.equal(await palitra.bridge.pollOnce(0), 2);
  const getUpdates = palitra.calls.telegram.find((call) => call.method === 'getUpdates');
  assert.deepEqual([getUpdates.body.offset, getUpdates.body.allowed_updates, getUpdates.token], [7, ['message', 'edited_message', 'callback_query'], TOKEN]);
  assert.deepEqual([project.getOffset(), palitra.bridge.getOffset(), other.bridge.getOffset()], [1000, 43, undefined],
    'группа не сохраняется, но отметка сдвигается; отметка бота Synapse не тронута');
  project.saveOffset(2000);
  assert.equal(palitra.bridge.getOffset(), 43);
  assert.equal(db.prepare("SELECT count(*) AS n FROM client_bot_inbox WHERE bot_key='palitra'").get().n, 1);
});

test('приём: событие уходит в службу диалогов, вложения скачиваются и передаются без ссылки с токеном', async () => {
  const downloads = [{ attachmentId: 1, fileId: 'voice-1', size: 10 }, { attachmentId: 2, fileId: 'big', size: null }, { attachmentId: 3, fileId: 'gone', size: 5 }];
  const { bridge, calls } = setup({
    telegram: (method, body) => {
      if (method !== 'getFile') return { result: { message_id: 1 } };
      if (body.file_id === 'big') return { result: { file_path: 'voice/big.oga', file_size: 5000 } };
      if (body.file_id === 'gone') return { status: 400, description: 'Bad Request: invalid file_id' };
      return { result: { file_path: 'voice/file_1.oga', file_size: 10 } };
    },
    content: (route) => (route === '/receive' ? json({ ok: true, downloads }) : null) });
  const update = privateMessage(1, 900, null, { voice: { file_id: 'voice-1' } });
  await bridge.receive(update);
  assert.deepEqual(routes(calls), ['/receive', '/attachment', '/attachment-status', '/attachment-status']);
  assert.deepEqual(calls.content[0].body, { update: { message: update.message } });
  assert.equal(calls.content[0].query.botKey, 'palitra');
  assert.equal(calls.content[0].headers['x-api-key'], 'service-key');
  assert.deepEqual([calls.content[1].query.id, calls.content[1].body.toString()], ['1', 'OggS-voice']);
  assert.deepEqual([calls.content[2].body.attachmentId, calls.content[2].body.status], [2, 'too_large']);
  assert.deepEqual([calls.content[3].body.attachmentId, calls.content[3].body.status], [3, 'unavailable']);
  assert.equal(calls.files.length, 1);
  for (const call of calls.content) assert.ok(!call.url.includes(TOKEN) && !JSON.stringify(call.body ?? '').includes(TOKEN), 'токен бота не уходит в службу диалогов');
});

test('очередь: временный сбой службы повторяется, отказ по содержимому закрывает событие, порядок внутри чата сохраняется', async () => {
  let fail = true;
  const { db, bridge, calls } = setup({ content: (route, body) => {
    if (route !== '/receive') return null;
    if (body.update.message.text === 'плохое') return json({ error: 'нет' }, 422);
    return fail && body.update.message.text === 'первое' ? json({ error: 'сбой' }, 503) : null;
  } });
  bridge.enqueue(privateMessage(1, 900, 'первое'));
  bridge.enqueue(privateMessage(2, 900, 'второе'));
  bridge.enqueue(privateMessage(3, 901, 'плохое'));
  await bridge.tick();
  const texts = () => calls.content.filter((call) => call.route === '/receive').map((call) => call.body.update.message.text);
  assert.deepEqual(texts(), ['первое', 'плохое'], 'второе сообщение того же чата ждёт первое');
  assert.deepEqual(bridge.failedInbox().map((row) => row.update_id), [3]);
  fail = false;
  db.prepare("UPDATE client_bot_inbox SET retry_at=0 WHERE update_id=1").run();
  await bridge.tick();
  assert.deepEqual(texts(), ['первое', 'плохое', 'первое', 'второе']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM client_bot_inbox WHERE state='pending'").get().n, 0);
  assert.equal(db.prepare("SELECT body FROM client_bot_inbox WHERE update_id=1").get().body, '{}', 'после обработки тело события не хранится');
});

test('доставка: части по порядку, отправленное не повторяется, неизвестный исход останавливает повторы, запрещённые методы не вызываются', async () => {
  let mode = 'ok';
  const { db, bridge, calls } = setup({ telegram: (method, body, count) => {
    if (method === 'setMessageReaction') return { status: 400, description: 'reactions disabled' };
    if (mode === 'second-5xx' && count === 2) return { status: 502 };
    if (mode === 'no-id') return { result: { ok: true } };
    if (mode === 'blocked') return { status: 403, description: 'Forbidden: bot was blocked by the user' };
    if (mode === 'limit') return { status: 429, description: 'Too Many Requests' };
    return { result: { message_id: 100 + count } };
  } });
  const job = (id, parts) => ({ id, parts, after: [{ method: 'setMessageReaction', params: { chat_id: '555', message_id: 1, reaction: [] } }] });
  const two = [{ method: 'sendMessage', params: { chat_id: '555', text: 'шапка' } }, { method: 'copyMessage', params: { chat_id: '555', from_chat_id: '900', message_id: 10 } }];
  assert.deepEqual(await bridge.delivery(job('cb:1', two)), { ok: true, externalMessageIds: ['101', '102'] }, 'сбой отметки 👌 не влияет на исход');
  assert.deepEqual(calls.telegram.map((call) => call.method), ['sendMessage', 'copyMessage', 'setMessageReaction']);
  mode = 'second-5xx'; calls.telegram.length = 0;
  const partial = await bridge.delivery({ id: 'cb:2', parts: two });
  assert.deepEqual([partial.ok, partial.uncertain, partial.externalMessageIds], [false, true, ['101']]);
  mode = 'ok';
  const retried = await bridge.delivery({ id: 'cb:2', parts: two });
  assert.deepEqual([retried.uncertain, calls.telegram.length], [true, 2], 'часть с неизвестным исходом не отправляется снова');
  mode = 'no-id';
  assert.equal((await bridge.delivery({ id: 'cb:3', parts: two.slice(0, 1) })).uncertain, true);
  mode = 'blocked';
  const blocked = await bridge.delivery({ id: 'cb:4', parts: two.slice(1) });
  assert.deepEqual([blocked.ok, blocked.uncertain, blocked.retryable], [false, false, false]);
  assert.match(blocked.error, /blocked by the user/);
  mode = 'limit';
  assert.equal((await bridge.delivery({ id: 'cb:5', parts: two.slice(1) })).retryable, true);
  const before = calls.telegram.length;
  const forbidden = await bridge.delivery({ id: 'cb:6', parts: [{ method: 'deleteMessage', params: { chat_id: '1', message_id: 1 } }] });
  assert.deepEqual([forbidden.ok, forbidden.retryable, calls.telegram.length], [false, false, before]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM client_bot_delivery WHERE job_id='cb:1' AND state='sent'").get().n, 2);
});

test('тихие часы: уведомления менеджеру ночью без звука; явный выбор не переопределяется', async () => {
  const { bridge, calls } = setup({ now: () => new Date('2026-09-29T20:30:00Z') });  // 23:30 МСК
  await bridge.delivery({ id: 'cb:1', parts: [{ method: 'sendMessage', params: { chat_id: '1', text: 'a' } },
    { method: 'copyMessage', params: { chat_id: '1', from_chat_id: '2', message_id: 3 } },
    { method: 'sendMessage', params: { chat_id: '1', text: 'b', disable_notification: false } }] });
  assert.deepEqual(calls.telegram.map((call) => call.body.disable_notification), [true, true, false]);
});

test('цикл: подтверждение сохраняется до обращения к службе и досылается после сбоя; задание не выдаётся повторно', async () => {
  let acks = 0, jobs = [{ id: 'cb:7', parts: [{ method: 'sendMessage', params: { chat_id: '555', text: 'Здравствуйте' } }] }];
  const { db, bridge, calls, sent } = setup({ content: (route) => {
    if (route === '/outbox') return json({ jobs: jobs.splice(0, 1) });
    if (route === '/acknowledge') { acks += 1; return acks === 1 ? json({ error: 'сбой' }, 503) : json({ ok: true }); }
    return null;
  } });
  await bridge.tick();
  assert.equal(sent().length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM client_bot_ack').get().n, 1, 'исход отправки сохранён локально');
  db.prepare('UPDATE client_bot_ack SET retry_at=0').run();
  await bridge.tick();
  const ack = calls.content.filter((call) => call.route === '/acknowledge').at(-1).body;
  assert.deepEqual([ack.jobId, ack.ok, ack.externalMessageIds], ['cb:7', true, ['500']]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM client_bot_ack').get().n, 0);
  assert.equal(sent().length, 1, 'повторной отправки нет');
});

test('кнопка статуса: ответ на нажатие и правка сообщения; их сбой не повторяет обработку', async () => {
  const { bridge, calls, sent } = setup({
    telegram: (method) => (method === 'editMessageText' ? { status: 400, description: 'message is not modified' } : { result: true }),
    content: (route) => (route === '/callback' ? json({ ok: true, answer: { text: 'Статус: В работе', showAlert: false },
      edit: { chatId: '555', messageId: 4, text: 'Заявка №1\n\nСтатус обработки: В работе', replyMarkup: { inline_keyboard: [] } } }) : null) });
  const update = { update_id: 9, callback_query: { id: 'q9', from: { id: 555 }, data: 'ow:1:in_work', message: { message_id: 4, chat: { id: 555, type: 'private' } } } };
  bridge.enqueue(update);
  await bridge.tick();
  assert.deepEqual(sent().map((call) => call.method), ['answerCallbackQuery', 'editMessageText']);
  assert.deepEqual(sent()[0].body, { callback_query_id: 'q9', text: 'Статус: В работе', show_alert: false });
  assert.deepEqual(calls.content.filter((call) => call.route === '/callback').map((call) => call.body.callback.data), ['ow:1:in_work']);
  assert.equal(bridge.failedInbox().length, 0);
});

test('webhook: без секрета и с неверным секретом события не принимаются; группы не сохраняются', () => {
  const { db, bridge } = setup();
  assert.throws(() => bridge.acceptWebhook('wrong', privateMessage(1, 900, 'x')), (error) => error.status === 401);
  assert.throws(() => bridge.acceptWebhook(undefined, privateMessage(1, 900, 'x')), (error) => error.status === 401);
  assert.deepEqual(bridge.acceptWebhook('hook-secret', privateMessage(1, 900, 'x')), { ok: true, queued: true });
  assert.deepEqual(bridge.acceptWebhook('hook-secret', { update_id: 2, message: { chat: { id: -1, type: 'group' } } }), { ok: true, queued: false });
  const open = setup({ webhookSecret: '' });
  assert.throws(() => open.bridge.acceptWebhook('', privateMessage(1, 900, 'x')), (error) => error.status === 401, 'пустой секрет не открывает приём');
  assert.equal(db.prepare('SELECT count(*) AS n FROM client_bot_inbox').get().n, 1);
});

test('getMe: токен другого бота или отказ — мост не опрашивает, не трогает webhook и ничего не отправляет; готовность сообщается в content', async () => {
  for (const me of [{ id: 1, is_bot: true, username: 'synapse_sb_bot' }, new Error('401')]) {
    let jobs = [{ id: 'cb:1', parts: [{ method: 'sendMessage', params: { chat_id: '555', text: 'x' } }] }];
    const { bridge, calls, sent } = setup({ me, content: (route) => (route === '/outbox' ? json({ jobs: jobs.splice(0, 1) }) : null) });
    bridge.enqueue(privateMessage(1, 900, 'Привет'));
    await bridge.tick();
    assert.equal(bridge.ready(), false);
    assert.deepEqual(routes(calls), ['/heartbeat'], 'ни событий, ни заданий без подтверждённого бота');
    assert.equal(calls.content[0].body.ok, false);
    assert.match(calls.content[0].body.error, me instanceof Error ? /Telegram/ : /synapse_sb_bot.*palitra_love_orders_bot/);
    bridge.start(); await new Promise((resolve) => setTimeout(resolve, 50)); bridge.stop();
    assert.deepEqual(sent().map((call) => call.method), [], 'deleteWebhook и getUpdates чужим токеном не вызываются');
  }
  const { bridge, calls } = setup();
  await bridge.tick();
  assert.equal(bridge.ready(), true);
  const beat = calls.content.find((call) => call.route === '/heartbeat').body;
  assert.deepEqual([beat.ok, beat.username, beat.botId], [true, 'palitra_love_orders_bot', '123456']);
  const noName = setup({ expectedUsername: '' });
  await noName.bridge.tick();
  assert.equal(noName.bridge.ready(), false, 'без ожидаемого имени бот не считается подтверждённым');
});

test('лимиты входящих: сверх лимита событие не пишется в очередь, повтор не тратит лимит, отправителю одно объяснение', async () => {
  let clock = Date.parse('2026-09-29T09:00:00Z');
  const { db, bridge, sent } = setup({ now: () => new Date(clock), limits: { perChatMinute: 2, perChatDay: 3, perBotHour: 4 } });
  await bridge.verify();
  const inbox = () => db.prepare('SELECT count(*) AS n FROM client_bot_inbox').get().n;
  assert.equal(bridge.enqueue(privateMessage(1, 900, 'a')), true);
  assert.equal(bridge.enqueue(privateMessage(1, 900, 'a')), true, 'повтор принятого — принят, лимит не тратится');
  assert.equal(bridge.enqueue(privateMessage(2, 900, 'b')), true);
  assert.equal(bridge.enqueue(privateMessage(3, 900, 'c')), false, 'третье за минуту — сверх лимита');
  assert.equal(bridge.enqueue(privateMessage(4, 900, 'd')), false);
  assert.equal(bridge.enqueue(privateMessage(3, 900, 'c')), false, 'повтор отброшенного остаётся отброшенным');
  assert.equal(inbox(), 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent().filter((call) => call.method === 'sendMessage').map((call) => call.body.chat_id), ['900'], 'одно объяснение за окно');
  assert.match(sent()[0].body.text, /сверх лимита не сохраняются/);
  clock += 61 * 1000;
  assert.equal(bridge.enqueue(privateMessage(5, 900, 'e')), true, 'через минуту снова можно');
  assert.equal(bridge.enqueue(privateMessage(6, 900, 'f')), false, 'суточный лимит чата — 3');
  assert.equal(bridge.enqueue(privateMessage(7, 901, 'g')), true);
  assert.equal(bridge.enqueue(privateMessage(8, 902, 'h')), false, 'лимит бота в час — 4 принятых события');
  assert.equal(inbox(), 4);
  assert.deepEqual(db.prepare('SELECT reason FROM client_bot_dropped ORDER BY update_id').all().map((row) => row.reason), ['chat_minute', 'chat_minute', 'chat_day', 'bot_hour']);
  assert.equal(bridge.enqueue({ update_id: 9, message: { chat: { id: -1, type: 'group' } } }), false, 'группы не считаются и не хранятся');
});
