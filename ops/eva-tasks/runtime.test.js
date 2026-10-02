'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RuntimeError, createAudit, loadConfig, readToken, createTelegramTransport, createState,
  validateOutput, processBatch, startupCheck, runOnce, poll } = require('./runtime');

const OWNER = 123456789;
const FAKE_TOKEN = '9001:TEST_ONLY_NO_REAL_CREDENTIAL';
const message = (id = 1) => ({ update_id: id, message: { message_id: 10, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: '/tasks' } });
const callback = (id = 1) => ({ update_id: id, callback_query: { id: 'query-id', from: { id: OWNER },
  message: { message_id: 10, chat: { id: OWNER, type: 'private' } }, data: 'opaque-token' } });
const send = (text = 'Test task display') => ({ method: 'sendMessage', params: { chat_id: OWNER, text } });
const bot = { handleUpdate: async () => [send()] };

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}eva-runtime-test-`));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

function memoryState(initial = -1) {
  return { lastUpdateId: initial, save(id) { this.lastUpdateId = id; } };
}

function response(result, status = 200) {
  return { ok: status === 200, status, json: async () => ({ ok: status === 200, result }) };
}

test('import is inert and does not load task source, read credentials or fetch', () => {
  const script = `global.fetch=()=>{throw new Error('network used')}; require(${JSON.stringify(path.join(__dirname, 'runtime.js'))});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env,
    EVA_TOKEN_FILE: 'missing', EVA_OWNER_USER_ID: 'invalid' } });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('config requires absolute paths, positive safe owner ID and real timezone', (t) => {
  const dir = temporaryDirectory(t);
  const env = { EVA_TOKEN_FILE: path.join(dir, 'token'), EVA_STATE_DIR: dir, EVA_DB_PATH: path.join(dir, 'crm.sqlite'), EVA_OWNER_USER_ID: String(OWNER) };
  assert.equal(loadConfig(env).timeZone, 'Etc/UTC');
  assert.equal(loadConfig({ ...env, EVA_TIMEZONE: 'Asia/Irkutsk' }).ownerUserId, OWNER);
  for (const owner of ['', '0', '-1', '1.2', ' 123 ', '00123', '9007199254740992', 'not-an-id']) {
    assert.throws(() => loadConfig({ ...env, EVA_OWNER_USER_ID: owner }), /invalid_config/);
  }
  for (const key of ['EVA_TOKEN_FILE', 'EVA_STATE_DIR', 'EVA_DB_PATH']) {
    for (const value of ['', '.', 'relative/file', undefined]) assert.throws(() => loadConfig({ ...env, [key]: value }), /invalid_config/);
  }
  for (const zone of ['Fake/Zone', '+03:00', 'Europe/Moscow\n', 'http://example.com']) {
    assert.throws(() => loadConfig({ ...env, EVA_TIMEZONE: zone }), /invalid_config/);
  }
});

test('token can only come from bounded file content; missing, empty or URL-like values fail redacted', (t) => {
  const dir = temporaryDirectory(t);
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, `${FAKE_TOKEN}\n`);
  assert.equal(readToken(file), FAKE_TOKEN);
  for (const content of ['', ' \n', 'https://evil.test/token', '9001:abc/../../evil', '9:abc\nxyz', 'x'.repeat(4097)]) {
    fs.writeFileSync(file, content);
    assert.throws(() => readToken(file), (error) => error.message === 'invalid_token_file' && !error.stack.includes(content || 'secret-never-here'));
  }
  assert.throws(() => readToken(path.join(dir, 'missing')), /^EvaRuntimeError: invalid_token_file$/);
});

test('transport fixes host, POST, no redirects, timeout, method allowlist', async () => {
  const calls = [];
  const transport = createTelegramTransport({ token: FAKE_TOKEN, fetchImpl: async (...args) => { calls.push(args); return response([]); } });
  await transport('getUpdates', { offset: 3 });
  const [url, options] = calls[0];
  assert.equal(url, `https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { offset: 3 });
  assert.ok(options.signal instanceof AbortSignal);
  for (const method of ['setWebhook', 'deleteWebhook', 'setMyCommands', 'sendDocument', '../getMe', 'https://evil.test']) {
    await assert.rejects(transport(method), /method_rejected/);
  }
  assert.equal(calls.length, 1);
});

test('transport respects cancellation and never exposes fetch or Telegram error content', async () => {
  const privateText = `${FAKE_TOKEN} https://api.telegram.org/private private-task-body`;
  const failures = [
    async () => { throw new Error(privateText); },
    async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, description: privateText, parameters: { retry_after: 300 } }) }),
    async () => ({ ok: false, status: 502, json: async () => { throw new Error(privateText); } }),
  ];
  const logs = [];
  const audit = createAudit((line) => logs.push(line));
  for (const fetchImpl of failures) {
    const transport = createTelegramTransport({ token: FAKE_TOKEN, fetchImpl });
    await assert.rejects(transport('getMe'), (error) => {
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(FAKE_TOKEN));
      assert.ok(!JSON.stringify(error).includes(privateText));
      audit('delivery_error', error.code);
      return error instanceof RuntimeError;
    });
  }
  audit(privateText, privateText);
  audit('poll_error', privateText);
  assert.deepEqual(logs.map(JSON.parse), [
    { event: 'delivery_error', code: 0 }, { event: 'delivery_error', code: 429 },
    { event: 'delivery_error', code: 502 }, { event: 'poll_error', code: 0 },
  ]);
  const controller = new AbortController();
  controller.abort();
  const transport = createTelegramTransport({ token: FAKE_TOKEN, fetchImpl: async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new Error(privateText);
  } });
  await assert.rejects(transport('getUpdates', {}, { signal: controller.signal }), /telegram_unavailable/);
});

test('persistent cursor is monotonic, atomic, minimal and protected by an exclusive lock', (t) => {
  const dir = temporaryDirectory(t);
  const first = createState({ stateDir: dir });
  assert.equal(first.lastUpdateId, -1);
  assert.throws(() => createState({ stateDir: dir }), /state_unavailable/);
  first.save(12);
  first.save(11);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8')), { version: 1, lastUpdateId: 12 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cursor.json', 'runtime.lock']);
  first.close();
  const second = createState({ stateDir: dir });
  assert.equal(second.lastUpdateId, 12);
  second.save(13);
  second.close();
  second.close();
});

test('stale lock is never stolen, including a nonexistent process ID', (t) => {
  const dir = temporaryDirectory(t);
  const lock = path.join(dir, 'runtime.lock');
  const content = JSON.stringify({ version: 1, pid: 999999999 });
  fs.writeFileSync(lock, content);
  assert.throws(() => createState({ stateDir: dir }), /state_unavailable/);
  assert.equal(fs.readFileSync(lock, 'utf8'), content);
});

test('malformed cursor never silently resets or leaks raw content', (t) => {
  const dir = temporaryDirectory(t);
  for (const content of ['not-json', '{"version":1,"lastUpdateId":-1}', '{"version":1,"lastUpdateId":"12"}',
    '{"version":2,"lastUpdateId":12}', '{"version":1,"lastUpdateId":12,"task":"private"}']) {
    fs.writeFileSync(path.join(dir, 'cursor.json'), content);
    assert.throws(() => createState({ stateDir: dir }), /^EvaRuntimeError: state_unavailable$/);
    assert.equal(fs.existsSync(path.join(dir, 'runtime.lock')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8'), content);
  }
});

test('save failure leaves previous cursor valid, poisons state and sends nothing', async (t) => {
  const dir = temporaryDirectory(t);
  const initial = createState({ stateDir: dir });
  initial.save(4);
  initial.close();
  let deliveries = 0;
  let reads = 0;
  const state = createState({ stateDir: dir, fsImpl: { ...fs, renameSync: () => { throw new Error(FAKE_TOKEN); } } });
  await assert.rejects(processBatch({ updates: [message(5)], state, ownerUserId: OWNER,
    bot: { handleUpdate: () => { reads++; return [send()]; } }, transport: async () => { deliveries++; } }), /cursor_save_failed/);
  assert.equal(reads, 0);
  assert.equal(deliveries, 0);
  assert.equal(state.lastUpdateId, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8')).lastUpdateId, 4);
  assert.throws(() => state.save(6), /cursor_save_failed/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cursor.json', 'runtime.lock']);
  state.close();
});

test('cursor is durably saved before delivery, and restart cannot replay a failed display', async (t) => {
  const dir = temporaryDirectory(t);
  let deliveries = 0;
  let reads = 0;
  const localBot = { handleUpdate: () => { reads++; return [send()]; } };
  const state = createState({ stateDir: dir });
  await processBatch({ updates: [message(21)], state, bot: localBot, ownerUserId: OWNER, transport: async () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8')).lastUpdateId, 21);
    deliveries++;
    throw new Error(`ambiguous response ${FAKE_TOKEN}`);
  } });
  state.close();
  const restarted = createState({ stateDir: dir });
  await processBatch({ updates: [message(21), message(22), message(22)], state: restarted, bot: localBot, ownerUserId: OWNER,
    transport: async () => { deliveries++; } });
  assert.equal(deliveries, 2);
  assert.equal(reads, 2);
  assert.equal(restarted.lastUpdateId, 22);
  restarted.close();
});

test('a crash after mark and before handler delivery loses only that display', async (t) => {
  const dir = temporaryDirectory(t);
  const child = spawnSync(process.execPath, ['-e',
    `const {createState}=require(${JSON.stringify(path.join(__dirname, 'runtime.js'))});`
      + `createState({stateDir:${JSON.stringify(dir)}}).save(30); process.exit(0);`], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
  assert.throws(() => createState({ stateDir: dir }), /state_unavailable/, 'process termination leaves a nonstealing crash lock');
  // The child has exited: this exact unlink simulates the documented operator action.
  fs.unlinkSync(path.join(dir, 'runtime.lock'));
  const restarted = createState({ stateDir: dir });
  let delivered = 0;
  await processBatch({ updates: [message(30)], state: restarted, bot, ownerUserId: OWNER, transport: async () => { delivered++; } });
  assert.equal(delivered, 0);
  restarted.close();
});

test('owner and private chat are checked on every message and callback before task reads', async () => {
  const denied = [message(1), message(2), message(3), callback(4), callback(5), callback(6), callback(7)];
  denied[0].message.from.id = OWNER + 1;
  denied[1].message.chat.id = OWNER + 1;
  denied[2].message.chat.type = 'group';
  denied[3].callback_query.from.id = OWNER + 1;
  denied[4].callback_query.message.chat.type = 'supergroup';
  denied[5].callback_query.from.id = String(OWNER);
  denied[6].callback_query.inline_message_id = 'inline-is-forbidden';
  let reads = 0;
  let deliveries = 0;
  const state = memoryState();
  await processBatch({ updates: denied, state, ownerUserId: OWNER,
    bot: { handleUpdate: () => { reads++; return [send()]; } }, transport: async () => { deliveries++; } });
  assert.equal(reads, 0);
  assert.equal(deliveries, 0);
  assert.equal(state.lastUpdateId, 7);
});

test('outbound defense rejects cross-chat, arbitrary methods, callback IDs and unsafe markup', async () => {
  const update = callback();
  const forbidden = [
    { method: 'deleteMessage', params: { chat_id: OWNER, message_id: 10 } },
    { ...send(), params: { ...send().params, chat_id: OWNER + 1 } },
    { ...send(), params: { ...send().params, chat_id: String(OWNER) } },
    { ...send(), params: { ...send().params, parse_mode: 'HTML' } },
    { ...send(), params: { ...send().params, reply_markup: { inline_keyboard: [[{ text: 'External', url: 'https://evil.test' }]] } } },
    { ...send(), params: { ...send().params, reply_markup: { inline_keyboard: [[{ text: 'External', url: 'https://synapse.synapsebusiness.ru/cabinet.html#tasks?token=x' }]] } } },
    { ...send(), params: { ...send().params, reply_markup: { inline_keyboard: [[{ text: 'Empty', callback_data: '' }]] } } },
    { method: 'answerCallbackQuery', params: { callback_query_id: 'other-user-callback' } },
    { method: 'editMessageText', params: { chat_id: OWNER, message_id: 11, text: 'Wrong card' } },
    { method: 'editMessageText', params: { chat_id: OWNER, inline_message_id: 'external', text: 'Wrong card' } },
  ];
  for (const action of forbidden) assert.throws(() => validateOutput(action, update, OWNER), /output_rejected/);
  let calls = 0;
  await processBatch({ updates: [update], state: memoryState(), ownerUserId: OWNER,
    bot: { handleUpdate: () => [send(), forbidden[0]] }, transport: async () => { calls++; } });
  assert.equal(calls, 0, 'validate the complete action list before any delivery');
  assert.deepEqual(validateOutput({ method: 'answerCallbackQuery', params: { callback_query_id: 'query-id' } }, update, OWNER),
    { method: 'answerCallbackQuery', params: { callback_query_id: 'query-id', cache_time: 0 } });
  const cabinet = 'https://synapse.synapsebusiness.ru/cabinet.html#tasks';
  assert.equal(validateOutput({ ...send(), params: { ...send().params,
    reply_markup: { inline_keyboard: [[{ text: 'Открыть кабинет', url: cabinet }]] } } }, update, OWNER)
    .params.reply_markup.inline_keyboard[0][0].url, cabinet);
});

test('authorized outputs preserve callback order, escaped plain text and disabled previews', async () => {
  const calls = [];
  const text = '<private task> & raw text';
  await processBatch({ updates: [callback()], state: memoryState(), ownerUserId: OWNER,
    bot: { handleUpdate: () => [
      { method: 'answerCallbackQuery', params: { callback_query_id: 'query-id' } },
      { method: 'editMessageText', params: { chat_id: OWNER, message_id: 10, text,
        reply_markup: { inline_keyboard: [[{ text: 'Назад', callback_data: 'opaque_token_12345678' }]] } } },
    ] }, transport: async (...args) => { calls.push(args); } });
  assert.deepEqual(calls.map(([method]) => method), ['answerCallbackQuery', 'editMessageText']);
  assert.equal(calls[1][1].text, text);
  assert.equal(calls[1][1].parse_mode, undefined);
  assert.deepEqual(calls[1][1].link_preview_options, { is_disabled: true });
});

test('real bot home, list and task card pass runtime destination and keyboard checks', async () => {
  const { createBot } = require('./bot');
  let reads = 0;
  const application = createBot({ ownerUserId: OWNER, timeZone: 'Etc/UTC', now: () => new Date('2026-10-02T12:00:00Z'),
    source: { listTasks: async () => {
      reads++;
      return [{ id: 5, title: 'Runtime integration fixture', companyCode: 'SYNAPSE', companyName: 'Synapse',
        status: 'in_progress', dueAt: '2026-10-02', nextAction: 'Review fixture', blocker: '', waitingForOwner: true }];
    } } });
  assert.equal(typeof application.handleUpdate, 'function');
  const state = memoryState();
  const calls = [];
  const transport = async (method, params) => { calls.push({ method, params }); };
  const handle = (update) => processBatch({ updates: [update], state, bot: application, ownerUserId: OWNER, transport });
  await handle(message(1));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.match(calls[0].params.text, /Eva/);
  const home = calls[0].params.reply_markup.inline_keyboard.flat();
  const today = home.find((button) => button.text.startsWith('Сегодня'));
  assert.ok(today?.callback_data);
  const listUpdate = callback(2);
  listUpdate.callback_query.data = today.callback_data;
  await handle(listUpdate);
  assert.deepEqual(calls.slice(1).map((call) => call.method), ['answerCallbackQuery', 'editMessageText']);
  const list = calls.at(-1);
  assert.match(list.params.text, /Runtime integration fixture/);
  const cardUpdate = callback(3);
  cardUpdate.callback_query.data = list.params.reply_markup.inline_keyboard[0][0].callback_data;
  await handle(cardUpdate);
  assert.equal(calls.length, 5);
  assert.match(calls.at(-1).params.text, /ID: CRM #5/);
  assert.equal(reads, 3);
});

test('runOnce only requests allowed updates with persisted offset and 30 second long poll', async () => {
  const calls = [];
  await runOnce({ state: memoryState(51), bot, ownerUserId: OWNER, transport: async (method, params) => {
    calls.push({ method, params }); return [];
  } });
  assert.deepEqual(calls, [{ method: 'getUpdates', params: { offset: 52, timeout: 30, limit: 50, allowed_updates: ['message', 'callback_query'] } }]);
});

test('startup checks bot identity, refuses existing webhook and never changes webhook or commands', async () => {
  const calls = [];
  await startupCheck({ expectedBotId: 9001, transport: async (method) => {
    calls.push(method); return method === 'getMe' ? { id: 9001, is_bot: true } : { url: '' };
  } });
  assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
  await assert.rejects(startupCheck({ expectedBotId: 9002, transport: async () => ({ id: 9001, is_bot: true }) }), /bot_identity_rejected/);
  await assert.rejects(startupCheck({ transport: async () => ({ id: 9001, is_bot: false }) }), /bot_identity_rejected/);
  await assert.rejects(startupCheck({ transport: async (method) => method === 'getMe'
    ? { id: 9001, is_bot: true } : { url: `https://private-hook/${FAKE_TOKEN}` } }), (error) => {
    assert.equal(error.message, 'webhook_present');
    assert.ok(!error.stack.includes(FAKE_TOKEN));
    return true;
  });
});

test('poll retries only transient failures with bounded backoff and stops on 409', async () => {
  const waits = [];
  let attempts = 0;
  await assert.rejects(poll({ state: memoryState(), bot, ownerUserId: OWNER,
    transport: async () => { attempts++; throw new RuntimeError('telegram_rejected', attempts < 10 ? 503 : 409); },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  }), (error) => error.code === 409);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(attempts, 10);
  for (const code of [400, 401, 403]) {
    let waited = false;
    await assert.rejects(poll({ state: memoryState(), bot, ownerUserId: OWNER,
      transport: async () => { throw new RuntimeError('telegram_rejected', code); }, sleep: async () => { waited = true; },
    }), (error) => error.code === code);
    assert.equal(waited, false);
  }
});

test('a dropped successful HTTP body retries polling with redacted transient error', async () => {
  const controller = new AbortController();
  const waits = [];
  const logs = [];
  let attempts = 0;
  const transport = createTelegramTransport({ token: FAKE_TOKEN, fetchImpl: async () => {
    attempts++;
    if (attempts === 1) return { ok: true, status: 200, json: async () => { throw new Error(`connection closed ${FAKE_TOKEN}`); } };
    controller.abort();
    return response([]);
  } });
  await poll({ state: memoryState(), bot, ownerUserId: OWNER, signal: controller.signal, transport,
    audit: createAudit((line) => logs.push(JSON.parse(line))), sleep: async (milliseconds) => { waits.push(milliseconds); } });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(logs, [{ event: 'poll_error', code: 0 }]);
});

test('cursor failure is fatal without polling retry, malformed IDs never reach handler', async () => {
  let reads = 0;
  let waited = false;
  await assert.rejects(poll({ state: { lastUpdateId: -1, save() { throw new RuntimeError('cursor_save_failed'); } },
    bot: { handleUpdate() { reads++; return []; } }, ownerUserId: OWNER,
    transport: async () => [message()], sleep: async () => { waited = true; } }), /cursor_save_failed/);
  assert.equal(reads, 0);
  assert.equal(waited, false);
  for (const id of [-1, '3', Number.MAX_SAFE_INTEGER, undefined, NaN]) {
    await assert.rejects(processBatch({ updates: [{ ...message(), update_id: id }], state: memoryState(), bot, ownerUserId: OWNER,
      transport: async () => { assert.fail('delivery forbidden'); } }), /invalid_updates/);
  }
});

test('graceful cancellation ends polling without retries or deliveries', async () => {
  const controller = new AbortController();
  let waited = false;
  await poll({ state: memoryState(), bot, ownerUserId: OWNER, signal: controller.signal,
    transport: async () => { controller.abort(); throw new RuntimeError('telegram_unavailable'); },
    sleep: async () => { waited = true; } });
  assert.equal(waited, false);
});
