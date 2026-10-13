'use strict';
/* PhaseE: ТОТ ЖЕ мост ops/chat/client-bot-bridge.js (изменённый E) поверх настоящих createClientDialogs +
   createCustomerChatNative + ядра и журнала загрузок. Сеть подменена fetchImpl моста: запросы к content уходят в настоящий
   clientDialogs.handleInternal (outbox, upload-source, acknowledge), запросы к Telegram — в локальный поддельный Bot API,
   который разбирает настоящий multipart FormData (поля и байты файла). globalThis.fetch запрещён.
   quiet-hours.js берётся рядом с мостом, если Root положил его в ops/chat, иначе — readonly BASE/quiet-hours.js
   (тот же модуль, без копирования в продукт). Две SQLite :memory: (content и мост), временный каталог (удаляется).
   Запуск (Root, Node 24): node --test web-upload-worker.test.cjs. Автор тест не запускал: результата прогона здесь нет. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DIR = __dirname;
const WORKER = path.join(DIR, 'ops', 'chat', 'client-bot-bridge.js');
const QUIET = fs.existsSync(path.join(DIR, 'ops', 'chat', 'quiet-hours.js')) ? path.join(DIR, 'ops', 'chat', 'quiet-hours.js') : path.join(DIR, 'BASE', 'quiet-hours.js');
const quietKit = require(QUIET);
/* Настоящий исходник моста, его './quiet-hours' — указанный выше модуль; остальные require — как обычно. */
function loadWorker() {
  const mod = new Module(WORKER, module);
  mod.filename = WORKER;
  const fn = vm.runInThisContext(Module.wrap(fs.readFileSync(WORKER, 'utf8')), { filename: WORKER });
  fn.call(mod.exports, mod.exports, (name) => (name === './quiet-hours' ? quietKit : require(name)), mod, WORKER, path.dirname(WORKER));
  return mod.exports;
}
const { createClientBotBridge } = loadWorker();
const { createClientDialogs } = require(path.join(DIR, 'client-dialogs.js'));
const { createCustomerChatNative } = require(path.join(DIR, 'customer-chat-native-adapter.cjs'));
const uploadKit = require(path.join(DIR, 'customer-chat-upload.cjs'));

const SITE = 'palitra', COMPANY = 'palitra-love', BOT = 'palitra', USERNAME = 'palitra_fixture_bot';
const OPERATOR = '10001', CUSTOMER = '20002', STRANGER = '30003';
const ORIGIN = 'https://palitra-worker-e.example';
const CONTENT = 'http://content.qa.invalid', API_KEY = 'qa-internal-key', TOKEN = 'QA-ONLY-TOKEN';
const OWNER = Object.freeze({ id: 17, sessionVersion: 4 });
const START = Date.parse('2026-10-14T09:00:00.000Z');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function png(width, height, pad = 64) {
  const b = Buffer.alloc(33 + pad, 3);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(120, 10)]);

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('QA: сеть запрещена'); };
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0, 'мост ходил только через fetchImpl стенда'); });

function stack(t, { bridgeNow = () => new Date(START) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phasee-worker-'));
  const db = new DatabaseSync(':memory:'), bridgeDb = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => { for (const d of [db, bridgeDb]) { try { d.close(); } catch (_) { /* закрыта */ } } fs.rmSync(root, { recursive: true, force: true }); });
  let inTx = false;
  const transaction = (fn) => {
    if (inTx) return fn();
    db.exec('BEGIN IMMEDIATE'); inTx = true;
    try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { inTx = false; }
  };
  const clock = { t: START };
  const now = () => clock.t;
  const siteOrders = { orderSummary: (site, id) => (site === SITE && Number(id) === 91 ? { id: 91 } : null),
    recipientStatus: () => ({ configured: true, telegramChatId: OPERATOR, transport: 'client_bot' }), isOrderJob: () => false, pendingTelegram: () => [] };
  const ownerStillValid = (id, version) => id === OWNER.id && version === OWNER.sessionVersion;
  const native = createCustomerChatNative({ db, transaction, siteOrders, ownerStillValid, origins: [ORIGIN], enabled: true, now, uploadsEnabled: true });
  const dialogs = createClientDialogs({ db, assetsDir: root, siteOrders, bots: { [BOT]: { site: SITE, companyCode: COMPANY, title: 'Fixture', username: USERNAME } },
    now, transact: transaction, chatIntegration: native.attach, ownerStillValid });
  db.prepare('INSERT INTO client_bot_operators(bot_key,telegram_user_id,bound_at) VALUES(?,?,?)').run(BOT, OPERATOR, new Date(START).toISOString());
  dialogs.heartbeat(BOT, { ok: true, username: USERNAME, botId: '9' });
  const core = native.core();
  const s = core.ensureWebSession({ site: SITE, origin: ORIGIN, cookie: '' }, { account: { kind: 'guest' } });
  const request = { site: SITE, origin: ORIGIN, cookie: s.setCookie.split(';')[0], csrf: s.csrfToken };
  const { thread } = core.createNewOrderThread(request, { orderId: 91 });

  /* ---------- поддельная сеть моста ---------- */
  const log = { content: [], telegram: [], downloads: [] };
  const faults = { source: [], ack: [], getFile: [], file: [], sendMessage: [], copyMessage: [], sendPhoto: [], sendDocument: [] };
  const tgFiles = new Map();
  let outgoing = 8000;
  const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload, body: null });
  const streamOf = (bytes) => ({ async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 64) yield new Uint8Array(bytes.subarray(i, i + 64)); }, cancel: async () => {} });
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    if (url.origin === CONTENT) {
      if ((init.headers || {})['x-api-key'] !== API_KEY) return reply(401, { error: 'Нет доступа' });
      const route = url.pathname.slice('/content/internal/client-bot'.length);
      log.content.push({ route, query: Object.fromEntries(url.searchParams) });
      if (route === '/upload-source') {
        const fault = faults.source.shift();
        if (fault === 'network') throw new TypeError('fetch failed');
        if (fault && fault.status) return reply(fault.status, { error: 'QA' });
        const sink = { status: 0, headers: {}, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { if (body) this.chunks.push(Buffer.from(body)); } };
        try {
          await dialogs.handleInternal({ method: 'GET', headers: {} }, sink, url, { readJson: async () => ({}), readRaw: async () => Buffer.alloc(0), send: () => { throw new Error('QA: не JSON'); } });
        } catch (error) { return reply(error.status || 500, { error: error.message }); }
        let bytes = Buffer.concat(sink.chunks);
        if (fault && fault.corrupt) { bytes = Buffer.from(bytes); bytes[bytes.length - 1] ^= 0xff; }
        return { ok: sink.status === 200, status: sink.status, body: streamOf(bytes), json: async () => null };
      }
      if (route === '/acknowledge') {
        const fault = faults.ack.shift();
        if (fault) return reply(fault, { error: 'QA: content недоступен' });
      }
      let sent = null;
      try {
        await dialogs.handleInternal({ method: init.method || 'GET', headers: {} }, {}, url, {
          readJson: async () => JSON.parse(init.body), readRaw: async () => Buffer.from(init.body), send: (_res, status, payload) => { sent = { status, payload }; } });
      } catch (error) { return reply(error.status || 500, { error: error.message }); }
      return reply(sent.status, sent.payload);
    }
    if (url.origin === 'https://api.telegram.org') {
      if (url.pathname.startsWith(`/file/bot${TOKEN}/`)) {
        const filePath = url.pathname.slice(`/file/bot${TOKEN}/`.length);
        log.downloads.push(filePath);
        const fault = faults.file.shift();
        if (fault) return { ok: false, status: fault.status, body: streamOf(Buffer.alloc(0)) };
        const found = [...tgFiles.values()].find((item) => item.path === filePath);
        return found ? { ok: true, status: 200, body: streamOf(found.bytes) } : { ok: false, status: 404, body: null };
      }
      const method = url.pathname.slice(`/bot${TOKEN}/`.length);
      let entry;
      if (init.body instanceof FormData) {
        const fields = {};
        for (const [key, value] of init.body.entries()) {
          fields[key] = typeof value === 'string' ? value : { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
        }
        entry = { method, multipart: true, fields, contentType: init.headers ? init.headers['content-type'] : undefined };
      } else entry = { method, multipart: false, body: JSON.parse(init.body || '{}') };
      log.telegram.push(entry);
      if (method === 'getMe') return reply(200, { ok: true, result: { id: 9, username: USERNAME } });
      if (method === 'getFile') {
        const fault = faults.getFile.shift();
        if (fault) return reply(fault.status, { ok: false, error_code: fault.status, description: 'QA' });
        const found = tgFiles.get(entry.body.file_id);
        return found ? reply(200, { ok: true, result: { file_id: entry.body.file_id, file_path: found.path, file_size: found.bytes.length } }) : reply(400, { ok: false, description: 'Bad Request' });
      }
      if (['sendMessage', 'copyMessage', 'sendPhoto', 'sendDocument'].includes(method)) {
        const fault = faults[method].shift();
        if (fault === 'network') throw new TypeError('fetch failed');
        if (fault) return reply(fault.status, { ok: false, error_code: fault.status, description: fault.description || 'Too Many Requests' });
        return reply(200, { ok: true, result: { message_id: ++outgoing } });
      }
      return reply(400, { ok: false, description: 'QA: метод не разрешён стендом' });
    }
    throw new Error(`QA: неожиданный адрес ${url.origin}`);
  }
  const makeBridge = () => createClientBotBridge({ db: bridgeDb, botKey: BOT, token: TOKEN, expectedUsername: USERNAME, contentUrl: CONTENT, apiKey: API_KEY,
    fetchImpl, quietHours: quietKit.parseQuietHours({}), now: bridgeNow, log: { warn: () => {}, error: () => {} } });
  let bridge = makeBridge();
  let updateId = 100, tgId = 600;
  const send = (from, extra) => {
    const message = { message_id: ++tgId, date: 1791936000, chat: { id: Number(from), type: 'private' }, from: { id: Number(from), is_bot: false, first_name: 'QA' }, ...extra };
    assert.equal(bridge.enqueue({ update_id: ++updateId, message }), true);
    return message;
  };
  const calls = (method) => log.telegram.filter((call) => call.method === method);
  const sends = () => log.telegram.filter((call) => ['sendMessage', 'copyMessage', 'sendPhoto', 'sendDocument'].includes(call.method));
  // Файл покупателя — те же функции ядра, что вызывает HTTP (prepare → begin → finish).
  function buyerUpload(bytes, { caption = '', name = 'foto.png' } = {}) {
    const prepared = core.prepareWebUpload(request, { threadId: thread.id, body: { requestId: crypto.randomUUID(), name, size: bytes.length, sha256: sha(bytes), caption } });
    const uuid = uploadKit.parseUploadRef(prepared.upload.ref);
    const begun = core.beginWebUpload(request, { threadId: thread.id, uuid });
    return core.finishWebUpload(request, { threadId: thread.id, uuid, claim: begun.claim, bytes });
  }
  function legacyUpload(dialogId, bytes, { caption = '', name = 'schet.pdf' } = {}) {
    const prepared = dialogs.prepareOwnerUpload(SITE, dialogId, { requestId: crypto.randomUUID(), name, size: bytes.length, sha256: sha(bytes), caption }, OWNER);
    const uuid = uploadKit.parseUploadRef(prepared.upload.ref);
    const begun = dialogs.beginOwnerUpload(SITE, dialogId, uuid, OWNER);
    return dialogs.finishOwnerUpload(SITE, dialogId, uuid, begun.claim, bytes, OWNER);
  }
  const delivery = (messageId, channel = 'manager_telegram') => db.prepare('SELECT * FROM chat_message_deliveries WHERE message_id=? AND channel=?').get(messageId, channel);
  const local = (jobId) => bridgeDb.prepare('SELECT part, state, external_id FROM client_bot_delivery WHERE job_id=? ORDER BY part').all(jobId);
  const outboxOf = (messageId) => db.prepare('SELECT q.* FROM chat_native_jobs n JOIN client_bot_outbox q ON q.id=n.job_id WHERE n.message_id=?').get(messageId);
  // Следующая попытка очереди — после её паузы (часы content).
  const later = () => { clock.t += 60 * 1000; dialogs.heartbeat(BOT, { ok: true, username: USERNAME, botId: '9' }); };
  const out = { db, bridgeDb, clock, dialogs, core, request, thread, faults, log, tgFiles, send, calls, sends, buyerUpload, legacyUpload, delivery, local, outboxOf, later };
  Object.defineProperty(out, 'bridge', { get: () => bridge });
  out.restartBridge = () => { bridge = makeBridge(); return bridge; };
  return out;
}

test('W1. Фото покупателя: мост берёт байты по upload-source ДО отправки, шапка — JSON sendMessage, файл — настоящий multipart sendPhoto; квитанция обеих частей и карта ответов менеджера', async (t) => {
  const s = stack(t);
  const bytes = png(800, 600);
  const done = s.buyerUpload(bytes, { caption: 'Образец цвета', name: 'образец.png' });
  await s.bridge.tick();
  const [header, photo] = s.sends();
  assert.deepEqual([header.method, header.multipart, header.body.chat_id], ['sendMessage', false, OPERATOR]);
  assert.match(header.body.text, /чат №\d+ · заявка №91 · фото/);
  assert.deepEqual([photo.method, photo.multipart, photo.contentType], ['sendPhoto', true, undefined], 'Content-Type с границей ставит FormData, JSON-заголовок не переносится');
  assert.deepEqual([photo.fields.chat_id, photo.fields.caption, photo.fields.photo.name, photo.fields.photo.type, Buffer.compare(photo.fields.photo.bytes, bytes)],
    [OPERATOR, 'Образец цвета', 'образец.png', 'image/png', 0]);
  assert.equal(photo.fields.parse_mode, undefined, 'без parse_mode');
  const order = s.log.content.map((entry) => entry.route);
  assert.ok(order.indexOf('/upload-source') > order.indexOf('/outbox') && order.indexOf('/upload-source') < order.lastIndexOf('/acknowledge'));
  const source = s.log.content.find((entry) => entry.route === '/upload-source');
  assert.deepEqual(Object.keys(source.query).sort(), ['botKey', 'jobId', 'part', 'ref'], 'фиксированный маршрут, только идентификаторы');
  assert.equal(source.query.ref, done.message.attachments[0].ref);
  const d = s.delivery(done.message.id);
  assert.deepEqual([d.status, JSON.parse(d.receipt).length], ['sent', 2]);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM chat_manager_map WHERE chat_message_id=?').get(done.message.id).n, 2, 'ответ «Ответить» — и на шапку, и на файл');
  assert.deepEqual(s.local(`cb:${s.outboxOf(done.message.id).id}`).map((p) => p.state), ['sent', 'sent']);
  // Ответ менеджера на копию файла — в тот же чат (прежняя механика D).
  const answer = s.send(OPERATOR, { text: 'Отличный цвет', reply_to_message: { message_id: Number(JSON.parse(d.receipt)[1]) } });
  await s.bridge.tick();
  assert.equal(s.db.prepare('SELECT thread_id FROM chat_thread_messages WHERE tg_message_id=?').get(answer.message_id).thread_id, s.thread.id);
});

test('W2. Владелец в прежний диалог: длинная подпись — текст один раз, sendDocument без подписи на тот же личный чат; тихие часы — disable_notification; строгий итог', async (t) => {
  const s = stack(t, { bridgeNow: () => new Date('2026-10-14T20:00:00.000Z') });   // 23:00 МСК — тихие часы
  s.send(STRANGER, { text: 'Здравствуйте' });
  await s.bridge.tick();
  const dialog = s.db.prepare('SELECT * FROM client_dialogs WHERE telegram_user_id=?').get(STRANGER);
  const before = s.sends().length;
  const caption = 'Д'.repeat(1500);
  const done = s.legacyUpload(dialog.id, PDF, { caption });
  await s.bridge.tick();
  const [text, file] = s.sends().slice(before);
  assert.deepEqual([text.method, text.body.chat_id, text.body.text, text.body.disable_notification], ['sendMessage', STRANGER, caption, true]);
  assert.deepEqual([file.method, file.fields.chat_id, file.fields.caption, file.fields.disable_notification, file.fields.document.name, Buffer.compare(file.fields.document.bytes, PDF)],
    ['sendDocument', STRANGER, undefined, 'true', 'schet.pdf', 0]);
  assert.equal(s.db.prepare('SELECT delivery_status FROM client_dialog_messages WHERE id=?').get(done.messageId).delivery_status, 'sent');
  assert.equal(s.db.prepare('SELECT status FROM client_bot_outbox WHERE id=?').get(Number(done.jobId.slice(3))).status, 'sent');
});

test('W3. Сбой чтения файла (503, обрыв, подмена байтов) — до отметки «sending» и без вызова Telegram: задание в очереди, шапка не повторяется, файл уходит один раз', async (t) => {
  const s = stack(t);
  const bytes = png(300, 200);
  const done = s.buyerUpload(bytes);
  const jobId = `cb:${s.outboxOf(done.message.id).id}`;
  s.faults.source.push({ status: 503 });
  await s.bridge.tick();
  assert.deepEqual(s.sends().map((c) => c.method), ['sendMessage'], 'шапка ушла, файл — нет');
  assert.deepEqual(s.local(jobId).map((p) => [p.part, p.state]), [[0, 'sent']], 'для части файла нет «sending»: Telegram не вызывался');
  assert.deepEqual([s.outboxOf(done.message.id).status, s.delivery(done.message.id).status, JSON.parse(s.delivery(done.message.id).receipt).length], ['pending', 'queued', 1]);
  // Вторая попытка (из трёх разрешённых очередью): байты пришли искажёнными — снова без Telegram.
  s.later();
  s.faults.source.push({ corrupt: true });
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendPhoto').length, s.calls('sendMessage').length, s.outboxOf(done.message.id).status], [0, 1, 'pending']);
  s.later();
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendMessage').length, s.calls('sendPhoto').length, s.delivery(done.message.id).status], [1, 1, 'sent']);
  // Обрыв связи с content — тоже не попытка Telegram.
  const net = s.buyerUpload(png(70, 70));
  s.faults.source.push('network');
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendPhoto').length, s.outboxOf(net.message.id).status], [1, 'pending']);
  s.later();
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendPhoto').length, s.delivery(net.message.id).status], [2, 'sent']);
  // Явный отказ content (задание больше не действует) — явный отказ канала, без Telegram.
  const second = s.buyerUpload(PDF, { name: 'b.pdf' });
  s.faults.source.push({ status: 409 });
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendDocument').length, s.outboxOf(second.message.id).status, s.delivery(second.message.id).status], [0, 'failed', 'failed']);
  // Смена менеджера до выдачи — прежняя остановка задания до upload-source.
  const third = s.buyerUpload(PDF, { name: 'c.pdf' });
  s.db.prepare("UPDATE client_bot_operators SET telegram_user_id='77777'").run();
  s.later();
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendDocument').length, s.delivery(third.message.id).status], [0, 'failed']);
});

test('W4. Начатый multipart без ответа — uncertain, без повтора и без другого метода; 429 на файле после шапки — повтор только файла', async (t) => {
  const s = stack(t);
  const first = s.buyerUpload(png(50, 50));
  s.faults.sendPhoto.push('network');
  await s.bridge.tick();
  assert.deepEqual([s.delivery(first.message.id).status, s.calls('sendPhoto').length], ['uncertain', 1]);
  s.later();
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendPhoto').length, s.calls('sendDocument').length], [1, 0], 'ни повтора, ни sendDocument после неизвестного исхода');
  const second = s.buyerUpload(png(60, 60));
  s.faults.sendPhoto.push({ status: 429 });
  await s.bridge.tick();
  assert.deepEqual([s.outboxOf(second.message.id).status, s.delivery(second.message.id).status, JSON.parse(s.delivery(second.message.id).receipt).length], ['pending', 'queued', 1]);
  const headers = s.calls('sendMessage').length;
  s.later();
  await s.bridge.tick();
  assert.deepEqual([s.calls('sendMessage').length, s.calls('sendPhoto').length, s.delivery(second.message.id).status], [headers, 3, 'sent'], 'шапка не повторяется, файл — второй раз');
});

test('W5. ACK 503 и перезапуск моста: итог доставляется из журнала ACK без повторных отправок', async (t) => {
  const s = stack(t);
  const done = s.buyerUpload(PDF, { name: 'a.pdf', caption: 'подпись' });
  s.faults.ack.push(503);
  await s.bridge.tick();
  const sent = s.sends().length;
  assert.equal(sent, 2);
  assert.equal(s.delivery(done.message.id).status, 'queued', 'итог ещё не в content');
  s.restartBridge();
  s.bridgeDb.prepare('UPDATE client_bot_ack SET retry_at=0').run();
  await s.bridge.tick();
  assert.deepEqual([s.sends().length, s.delivery(done.message.id).status, JSON.parse(s.delivery(done.message.id).receipt).length], [sent, 'sent', 2]);
});

test('W6. Мост отвергает файловую часть без сведений о байтах или с лишними параметрами — без вызова Telegram; ремонт: HTTP 429 скачивания вложения — повтор, а не «недоступен»', async (t) => {
  const s = stack(t);
  for (const parts of [[{ method: 'sendDocument', params: { chat_id: '1' } }],
    [{ method: 'sendDocument', params: { chat_id: '1', parse_mode: 'HTML' }, upload: { ref: `upload:${crypto.randomUUID()}`, size: 10, sha256: 'a'.repeat(64), name: 'a', type: 'application/pdf' } }],
    [{ method: 'sendMessage', params: { chat_id: '1', text: 'x' }, upload: { ref: 'x' } }],
    [{ method: 'sendPhoto', params: { chat_id: '1' }, upload: { ref: `upload:${crypto.randomUUID()}`, size: 21 * 1024 * 1024, sha256: 'a'.repeat(64), name: 'a', type: 'image/png' } }]]) {
    const result = await s.bridge.delivery({ id: 'cb:999', parts });
    assert.deepEqual([result.ok, result.retryable, result.uncertain], [false, false, false], JSON.stringify(parts));
  }
  assert.equal(s.sends().length, 0);
  // Ремонт D: временный 429 при скачивании файла клиента — событие остаётся в очереди и повторяется.
  const link = s.core.issueTelegramLink(s.request, { threadId: s.thread.id });
  s.send(CUSTOMER, { text: `/start ${link.startPayload}` });
  await s.bridge.tick();
  s.tgFiles.set('ph-1', { path: 'photos/a.jpg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]) });
  s.send(CUSTOMER, { photo: [{ file_id: 'ph-1', file_size: 204 }] });
  s.faults.file.push({ status: 429 });
  await s.bridge.tick();
  assert.equal(s.log.content.some((entry) => entry.route === '/attachment-status'), false, '429 — не «файл недоступен»');
  assert.equal(s.db.prepare('SELECT status FROM chat_thread_attachments ORDER BY id DESC LIMIT 1').get().status, 'pending');
  s.bridgeDb.prepare('UPDATE client_bot_inbox SET retry_at=0').run();
  await s.bridge.tick();
  assert.equal(s.db.prepare('SELECT status FROM chat_thread_attachments ORDER BY id DESC LIMIT 1').get().status, 'stored');
});
