'use strict';
/* PhaseE: файл с сайта и из приложения на настоящих фабриках — createCustomerChatHttp (покупатель), createCustomerChatNative
   + ядро customer-chat.js (владелец в чат сайта), createClientDialogs (владелец в прежний диалог, внутренний upload-source,
   очередь и ACK), customer-chat-upload.cjs и принятое D хранилище customer-chat-media.cjs.
   SQLite :memory:, временный приватный каталог (удаляется в t.after), сеть запрещена (fetch бросает и считается).
   server.js здесь не поднимается (он открывает базу и порт): его маршруты владельца вызывают ровно эти функции модулей.
   Запуск (Root, Node 24): node --test web-upload.test.cjs. Автор тест не запускал: результата прогона здесь нет. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');

const DIR = __dirname;
const { createClientDialogs } = require(path.join(DIR, 'client-dialogs.js'));
const { createCustomerChatNative } = require(path.join(DIR, 'customer-chat-native-adapter.cjs'));
const { createCustomerChatHttp } = require(path.join(DIR, 'customer-chat-http.cjs'));
const mediaKit = require(path.join(DIR, 'customer-chat-media.cjs'));
const uploadKit = require(path.join(DIR, 'customer-chat-upload.cjs'));

const SITE = 'palitra', COMPANY = 'palitra-love', BOT = 'palitra', USERNAME = 'palitra_fixture_bot';
const OPERATOR = '10001', CUSTOMER = '20002', STRANGER = '30003';
const ORIGIN = 'https://palitra-upload-fixture.example';
const HOST = new URL(ORIGIN).hostname;
const OWNER = Object.freeze({ id: 17, sessionVersion: 4 });
const START = Date.parse('2026-10-14T09:00:00.000Z');
const MIB = 1024 * 1024;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('QA: сеть запрещена'); };
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0, 'ни одного сетевого вызова'); });

/* Синтетические байты с настоящими сигнатурами и заголовками размеров. */
function png(width, height, pad = 32) {
  const b = Buffer.alloc(33 + pad, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
function jpeg(width, height, total = 64) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 0x03]);
  const b = Buffer.alloc(Math.max(total, head.length + 8), 0);
  head.copy(b);
  return b;
}
const BYTES = Object.freeze({
  pdf: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(55, 10)]),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'),
  html: Buffer.from('<!doctype html><html><script>alert(1)</script></html>'),
  ogg: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 5)]),
});

/* ---------- стенд ---------- */
function fixture(t, { maxStorage, uploadsEnabled = true, bridge = true, operator = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phasee-upload-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => { try { db.close(); } catch (_) { /* уже закрыта */ } fs.rmSync(root, { recursive: true, force: true }); });
  let inTx = false;
  const transaction = (fn) => {
    if (inTx) return fn();
    db.exec('BEGIN IMMEDIATE'); inTx = true;
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { inTx = false; }
  };
  const clock = { t: START };
  const now = () => clock.t;
  const recipient = { chatId: OPERATOR };
  const owner = { valid: true };
  const ownerValid = (id, version) => owner.valid && id === OWNER.id && version === OWNER.sessionVersion;
  const siteOrders = { orderSummary: (site, id) => (site === SITE && [91, 92].includes(Number(id)) ? { id: Number(id) } : null),
    recipientStatus: () => ({ configured: true, telegramChatId: recipient.chatId, transport: 'client_bot' }), isOrderJob: () => false, pendingTelegram: () => [] };
  const build = () => {
    const builtNative = createCustomerChatNative({ db, transaction, siteOrders, ownerStillValid: ownerValid, origins: [ORIGIN], enabled: true, now, uploadsEnabled });
    const builtDialogs = createClientDialogs({ db, assetsDir: root, siteOrders, bots: { [BOT]: { site: SITE, companyCode: COMPANY, title: 'Fixture', username: USERNAME } },
      now, transact: transaction, chatIntegration: builtNative.attach, ownerStillValid: ownerValid, ...(maxStorage !== undefined ? { maxStorage } : {}) });
    return { native: builtNative, dialogs: builtDialogs };
  };
  let { native, dialogs } = build();
  if (operator) db.prepare('INSERT INTO client_bot_operators(bot_key,telegram_user_id,bound_at) VALUES(?,?,?)').run(BOT, OPERATOR, new Date(START).toISOString());
  const beat = () => { if (bridge) assert.equal(dialogs.heartbeat(BOT, { ok: true, username: USERNAME, botId: '9' }).ok, true); };
  beat();
  let core = native.core();
  const session = () => {
    const s = core.ensureWebSession({ site: SITE, origin: ORIGIN, cookie: '' }, { account: { kind: 'guest' } });
    return { site: SITE, origin: ORIGIN, cookie: s.setCookie.split(';')[0], csrf: s.csrfToken };
  };
  const request = session();
  const { thread } = core.createNewOrderThread(request, { orderId: 91 });
  let tgId = 700;
  const message = (from, extra) => ({ message_id: ++tgId, date: 1791936000, chat: { id: Number(from), type: 'private' }, from: { id: Number(from), is_bot: false, first_name: 'QA' }, ...extra });
  const receive = (from, extra) => dialogs.receive(BOT, { message: message(from, extra) });
  const claim = () => {
    const link = core.issueTelegramLink(request, { threadId: thread.id });
    assert.equal(receive(CUSTOMER, { text: `/start ${link.startPayload}` }).action, 'site_chat_linked');
  };
  const http = createCustomerChatHttp({ core: () => native.core(), site: SITE, origins: [ORIGIN], account: () => null, botUsername: () => USERNAME, enabled: true, log: { error: () => {} } });
  /* Настоящий http.handle: тело — асинхронный поток (как у node:http), заголовки — как у браузера. */
  async function call(method, pathname, { json, raw, as = request, origin = ORIGIN, csrf, cookie, contentType, onRead } = {}) {
    const body = json !== undefined ? Buffer.from(JSON.stringify(json)) : raw;
    const headers = { host: HOST,
      ...((cookie ?? as.cookie) ? { cookie: cookie ?? as.cookie } : {}),
      ...(origin ? { origin } : {}),
      ...((csrf === undefined ? as.csrf : csrf) ? { 'x-palitra-chat-csrf': csrf === undefined ? as.csrf : csrf } : {}),
      ...(body !== undefined ? { 'content-type': contentType || (json !== undefined ? 'application/json' : 'application/octet-stream'), 'content-length': String(body.length) } : {}) };
    const res = fakeResponse();
    await http.handle({ method, url: pathname, headers, async *[Symbol.asyncIterator]() { if (onRead) await onRead(); if (body !== undefined && body.length) yield body; } }, res, HOST);
    await res.done;
    return res;
  }
  const storage = path.join(root, 'client-dialogs');
  const files = () => (fs.existsSync(storage) ? fs.readdirSync(storage).filter((name) => !name.endsWith('.part')).sort() : []);
  const uploads = () => db.prepare('SELECT * FROM chat_web_uploads ORDER BY created_at, upload_uuid').all();
  const uploadRow = (uuid) => db.prepare('SELECT * FROM chat_web_uploads WHERE upload_uuid=?').get(uuid);
  const jobsOf = (messageId) => db.prepare('SELECT n.target, q.* FROM chat_native_jobs n JOIN client_bot_outbox q ON q.id=n.job_id WHERE n.message_id=? ORDER BY n.job_id').all(messageId);
  const count = (sql, ...args) => Number(db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...args).n);
  const out = { root, storage, db, clock, recipient, owner, native, dialogs, core, request, thread, session, receive, message, claim, call, files, uploads, uploadRow, jobsOf, count, beat };
  // Перезапуск процесса: новые фабрики над той же базой и тем же каталогом.
  out.restart = () => { ({ native, dialogs } = build()); core = native.core(); Object.assign(out, { native, dialogs, core }); beat(); return out; };
  return out;
}
function fakeResponse() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.statusCode = 0; res.headers = null; res.headersSent = false;
  res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headers = { ...headers }; res.headersSent = true; return res; };
  const end = res.end.bind(res);
  res.end = (body) => { if (body !== undefined && body !== null) chunks.push(Buffer.from(body)); return end(); };
  res.done = new Promise((resolve) => res.on('finish', resolve));
  res.body = () => Buffer.concat(chunks);
  res.json = () => JSON.parse(res.body().toString('utf8') || 'null');
  return res;
}
const prepareBody = (bytes, { requestId = crypto.randomUUID(), name = 'file.bin', caption = '' } = {}) => ({ requestId, name, size: bytes.length, sha256: sha(bytes), caption });
/* Покупатель: prepare → bytes через настоящий HTTP. */
async function buyerUpload(f, bytes, { requestId = crypto.randomUUID(), name = 'photo.png', caption = '', threadId = f.thread.id, as = f.request, raw = bytes } = {}) {
  const prepared = await f.call('POST', `/api/customer-chat/threads/${threadId}/uploads`, { json: prepareBody(bytes, { requestId, name, caption }), as });
  const body = prepared.json();
  if (prepared.statusCode >= 300) return { prepared, body, requestId };
  const ref = body.upload.ref, uuid = uploadKit.parseUploadRef(ref);
  const sent = await f.call('POST', `/api/customer-chat/threads/${threadId}/uploads/${ref}/bytes`, { raw, as });
  return { prepared, body, ref, uuid, requestId, sent, result: sent.json() };
}
/* Владелец: те же функции, что вызывает server.js (после его проверок Origin/CSRF/свежей сессии). */
function ownerThreadUpload(f, bytes, { requestId = crypto.randomUUID(), name = 'smeta.pdf', caption = '', owner = OWNER, threadId = f.thread.id } = {}) {
  const prepared = f.native.owner.prepareUpload({ owner, threadId, body: prepareBody(bytes, { requestId, name, caption }) });
  const uuid = uploadKit.parseUploadRef(prepared.upload.ref);
  const begun = f.native.owner.beginUpload({ owner, threadId, uuid });
  const done = f.native.owner.finishUpload({ owner, threadId, uuid, claim: begun.claim || null, bytes });
  return { prepared, uuid, ref: prepared.upload.ref, done, requestId };
}
function ownerLegacyUpload(f, dialogId, bytes, { requestId = crypto.randomUUID(), name = 'schet.pdf', caption = '', owner = OWNER } = {}) {
  const prepared = f.dialogs.prepareOwnerUpload(SITE, dialogId, prepareBody(bytes, { requestId, name, caption }), owner);
  const uuid = uploadKit.parseUploadRef(prepared.upload.ref);
  const begun = f.dialogs.beginOwnerUpload(SITE, dialogId, uuid, owner);
  const done = f.dialogs.finishOwnerUpload(SITE, dialogId, uuid, begun.claim || null, bytes, owner);
  return { prepared, uuid, ref: prepared.upload.ref, done, requestId };
}
async function readProtected(resolve, open, method = 'GET') {
  const res = fakeResponse();
  mediaKit.serveProtected({ request: { method, headers: {} }, response: res, resolve, open });
  await res.done;
  return res;
}
async function internalGet(f, route, query) {
  const url = new URL(`http://content.internal/content/internal/client-bot${route}`);
  url.searchParams.set('botKey', BOT);
  for (const [key, value] of Object.entries(query)) url.searchParams.append(key, value);
  const res = fakeResponse();
  let sent = null;
  try {
    await f.dialogs.handleInternal({ method: 'GET', headers: {} }, res, url, { readJson: async () => ({}), readRaw: async () => Buffer.alloc(0),
      send: (_res, status, payload) => { sent = { status, payload }; } });
  } catch (error) { return { status: error.status || 500, code: error.code }; }
  if (sent) return sent;
  await res.done;
  return { status: res.statusCode, body: res.body(), headers: res.headers };
}
// Мост: выдать и подтвердить все задания (полный набор номеров — по номеру на часть).
let externalId = 50000;
function drainAll(f) {
  for (let guard = 0; guard < 40; guard += 1) {
    const jobs = f.dialogs.pendingJobs(BOT);
    if (!jobs.length) return;
    for (const job of jobs) f.dialogs.acknowledge(BOT, { jobId: job.id, ok: true, externalMessageIds: job.parts.map(() => String(++externalId)) });
  }
  throw new Error('очередь не опустела');
}
const legacyDialog = (f, user = STRANGER) => {
  f.receive(user, { text: 'Здравствуйте, есть вопрос по заказу' });
  return f.db.prepare('SELECT * FROM client_dialogs WHERE telegram_user_id=?').get(user);
};
const privateFree = (value, row) => { const text = JSON.stringify(value); return !text.includes(row.disk_name) && !text.includes(os.tmpdir()) && !text.includes('file_id'); };

/* ======================================================================================================
   1. Три цели: покупатель, владелец в чат сайта, владелец в прежний диалог
   ====================================================================================================== */
test('E1. Покупатель: файл с подписью → одна запись истории, одна загрузка, одна квитанция; копия менеджеру — шапка + sendPhoto; байты читают покупатель и владелец', async (t) => {
  const f = fixture(t);
  const bytes = png(640, 480);
  const before = { messages: f.count('chat_thread_messages'), requests: f.count('chat_thread_requests'), legacy: f.count('client_dialog_messages') };
  const up = await buyerUpload(f, bytes, { caption: 'Вот образец цвета', name: '../../секрет/образец.png' });
  assert.equal(up.prepared.statusCode, 201);
  assert.deepEqual([up.body.upload.state, up.body.upload.name, up.body.upload.size, up.body.duplicate], ['prepared', 'образец.png', bytes.length, false], 'имя — только для показа, без пути');
  assert.equal(up.sent.statusCode, 201);
  const result = up.result;
  assert.deepEqual([result.ok, result.duplicate, result.threadId, result.requestId, result.upload.state], [true, false, f.thread.id, up.requestId, 'committed']);
  const stored = f.db.prepare('SELECT * FROM chat_thread_messages WHERE id=?').get(result.message.id);
  assert.deepEqual([stored.author_kind, stored.source_channel, stored.direction, stored.text, stored.tg_message_id], ['customer', 'web', 'in', 'Вот образец цвета', null]);
  assert.deepEqual({ messages: f.count('chat_thread_messages'), requests: f.count('chat_thread_requests'), legacy: f.count('client_dialog_messages') },
    { messages: before.messages + 1, requests: before.requests + 1, legacy: before.legacy }, 'одна запись, одна квитанция, legacy не пишется');
  const row = f.uploadRow(up.uuid);
  assert.deepEqual([row.state, row.thread_message_id, row.legacy_message_id, row.actual_sha256, row.kind, row.presentation, row.width, row.height],
    ['committed', stored.id, null, sha(bytes), 'photo', 'image', 640, 480]);
  assert.deepEqual(result.message.attachments, [{ ref: up.ref, kind: 'photo', mime: 'image/png', name: 'образец.png', size: bytes.length, storageStatus: 'stored', error: '', presentation: 'image' }]);
  assert.ok(privateFree(result, row) && privateFree(up.body, row), 'в ответах нет имени на диске и путей');
  assert.deepEqual(f.files(), [row.disk_name], 'одна приватная копия под серверным UUID');
  // Копия менеджеру — прежняя очередь: шапка sendMessage и файл sendPhoto с подписью (≤ 1024), без copyMessage.
  const jobs = f.jobsOf(stored.id);
  assert.equal(jobs.length, 1);
  const parts = JSON.parse(jobs[0].parts);
  assert.deepEqual([jobs[0].target, jobs[0].kind, parts.map((p) => p.method)], ['manager', 'forward', ['sendMessage', 'sendPhoto']]);
  assert.match(parts[0].params.text, new RegExp(`чат №${f.thread.id}.*фото`));
  assert.equal(parts[0].params.text.includes('образец цвета'), false, 'подпись не дублируется в шапке');
  assert.deepEqual(parts[1], { method: 'sendPhoto', params: { chat_id: OPERATOR, caption: 'Вот образец цвета' },
    upload: { ref: up.ref, size: bytes.length, sha256: sha(bytes), name: 'образец.png', type: 'image/png' } });
  assert.ok(privateFree(parts, row));
  // Покупатель читает по своей cookie (без Origin — фактический хост), владелец — защищённым маршрутом владельца.
  const file = await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/attachments/${up.ref}`, { origin: null, csrf: '' });
  assert.deepEqual([file.statusCode, Buffer.compare(file.body(), bytes), file.headers['Content-Type'], file.headers['Cache-Control']], [200, 0, 'image/png', 'private, no-store']);
  assert.match(file.headers['Content-Disposition'], /^inline;/);
  const ownerFile = await readProtected(() => f.native.owner.uploadFile({ owner: OWNER, threadId: f.thread.id, uuid: up.uuid }), (m) => f.native.owner.openUpload(m));
  assert.deepEqual([ownerFile.statusCode, Buffer.compare(ownerFile.body(), bytes)], [200, 0]);
  // Состояние — только чтение и точная квитанция после завершения.
  const status = await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/uploads/${up.ref}`, { origin: null, csrf: '' });
  assert.deepEqual([status.statusCode, status.json().upload.state, status.json().message.id], [200, 'committed', stored.id]);
  const history = f.core.listWebMessages(f.request, { threadId: f.thread.id });
  assert.deepEqual(history.uploads, { enabled: true, maxBytes: 20 * MIB });
  assert.equal(history.messages.find((m) => m.id === stored.id).attachments[0].ref, up.ref);
  const ownerView = f.core.ownerReadThread({ site: SITE, owner: OWNER, threadId: f.thread.id }).messages.find((m) => m.id === stored.id);
  assert.deepEqual([ownerView.attachments[0].ref, ownerView.deliveries[0].channel, ownerView.deliveries[0].status], [up.ref, 'manager_telegram', 'queued']);
});

test('E1b. Без Telegram (нет бота, менеджера, моста): файл и сообщение всё равно сохранены и читаются; копия — честный not_queued; прежние вложения Telegram (thread:N) рядом', async (t) => {
  const f = fixture(t, { bridge: false, operator: false });
  const up = await buyerUpload(f, BYTES.pdf, { name: 'смета.pdf' });
  assert.deepEqual([up.sent.statusCode, up.result.upload.state], [201, 'committed']);
  const id = up.result.message.id;
  assert.deepEqual(f.jobsOf(id), [], 'в очередь ничего не ушло');
  const delivery = f.db.prepare('SELECT status, reason FROM chat_message_deliveries WHERE message_id=?').get(id);
  assert.equal(delivery.status, 'not_queued');
  const file = await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/attachments/${up.ref}`, { origin: null, csrf: '' });
  assert.deepEqual([file.statusCode, Buffer.compare(file.body(), BYTES.pdf), file.headers['Content-Type']], [200, 0, 'application/octet-stream']);
  assert.match(file.headers['Content-Disposition'], /^attachment;/, 'документ — только скачивание');
  // Прежний D: вложение Telegram в том же чате — своя ссылка thread:N, своя таблица.
  f.beat();
  const g = fixture(t);
  g.claim();
  g.receive(CUSTOMER, { document: { file_id: 'tg-doc', file_name: 'old.pdf' } });
  const typed = g.db.prepare('SELECT * FROM chat_thread_attachments').get();
  const web = await buyerUpload(g, BYTES.pdf, { name: 'new.pdf' });
  const history = g.core.listWebMessages(g.request, { threadId: g.thread.id }).messages;
  assert.deepEqual(history.flatMap((m) => (m.attachments || []).map((a) => a.ref)), [mediaKit.typedRef(typed.id), web.ref], 'thread:N и upload:<UUID> — разные пространства');
});

test('E2. Владелец в чат сайта: файл без подписи и с длинной подписью → запись owner/app, клиенту в Telegram — текст один раз + sendDocument без подписи; покупатель читает байты', async (t) => {
  const f = fixture(t);
  f.claim();
  const long = 'Л'.repeat(1200);
  const up = ownerThreadUpload(f, BYTES.pdf, { caption: long });
  assert.deepEqual([up.done.ok, up.done.duplicate, up.done.threadId, up.done.upload.state], [true, false, f.thread.id, 'committed']);
  const stored = f.db.prepare('SELECT * FROM chat_thread_messages WHERE id=?').get(up.done.message.id);
  assert.deepEqual([stored.author_kind, stored.source_channel, stored.direction, stored.text, stored.owner_user_id], ['owner', 'app', 'out', long, OWNER.id]);
  assert.equal(f.db.prepare("SELECT actor_ref FROM chat_thread_requests WHERE message_id=?").get(stored.id).actor_ref, `owner:${OWNER.id}`);
  const [job] = f.jobsOf(stored.id);
  const parts = JSON.parse(job.parts);
  assert.deepEqual([job.target, job.kind, parts.map((p) => p.method)], ['customer', 'reply', ['sendMessage', 'sendDocument']]);
  assert.deepEqual([parts[0].params.text, parts[0].params.chat_id, parts[1].params], [long, CUSTOMER, { chat_id: CUSTOMER }], 'подпись > 1024 — текстом один раз, файл без подписи');
  const buyer = await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/attachments/${up.ref}`, { origin: ORIGIN, csrf: '' });
  assert.deepEqual([buyer.statusCode, Buffer.compare(buyer.body(), BYTES.pdf)], [200, 0]);
  const bare = ownerThreadUpload(f, png(100, 100));
  const bareParts = JSON.parse(f.jobsOf(bare.done.message.id)[0].parts);
  assert.deepEqual(bareParts, [{ method: 'sendPhoto', params: { chat_id: CUSTOMER },
    upload: { ref: bare.ref, size: png(100, 100).length, sha256: sha(png(100, 100)), name: 'smeta.pdf', type: 'image/png' } }], 'без подписи — одна часть файла');
  assert.equal(f.core.ownerReadThread({ site: SITE, owner: OWNER, threadId: f.thread.id }).uploads.enabled, true);
});

test('E2b. Подпись и M2: 1024 символа — подпись файла; 1025 — текст + файл без подписи; своя копия клиента с «Вы написали на сайте» учитывается в 1024', async (t) => {
  const f = fixture(t);
  f.claim();
  const label = 'Вы написали на сайте:\n';
  const fits = 'а'.repeat(1024 - label.length);
  const self = await buyerUpload(f, BYTES.pdf, { caption: fits, name: 'a.pdf' });
  const selfJobs = f.jobsOf(self.result.message.id);
  const customer = JSON.parse(selfJobs.find((j) => j.target === 'customer').parts);
  assert.deepEqual([customer.length, customer[0].method, customer[0].params.caption], [1, 'sendDocument', `${label}${fits}`], 'ровно 1024 с подписью — в подписи файла');
  const manager = JSON.parse(selfJobs.find((j) => j.target === 'manager').parts);
  assert.deepEqual([manager.map((p) => p.method), manager[1].params.caption], [['sendMessage', 'sendDocument'], fits], 'менеджеру — без подписи «Вы написали…», шапка отдельно');
  const over = await buyerUpload(f, BYTES.ogg, { caption: `${fits}б`, name: 'b.ogg' });
  const overCustomer = JSON.parse(f.jobsOf(over.result.message.id).find((j) => j.target === 'customer').parts);
  assert.deepEqual([overCustomer.map((p) => p.method), overCustomer[0].params.text, overCustomer[1].params.caption], [['sendMessage', 'sendDocument'], `${label}${fits}б`, undefined]);
  const bare = await buyerUpload(f, BYTES.pdf, { name: 'c.pdf' });
  const bareCustomer = JSON.parse(f.jobsOf(bare.result.message.id).find((j) => j.target === 'customer').parts);
  assert.deepEqual(bareCustomer[0].params.caption, 'Вы написали на сайте:', 'без подписи — одна строка метки, без пустого хвоста');
  assert.equal(uploadKit.captionPlan('x'.repeat(1024)).caption.length, 1024);
  assert.deepEqual(uploadKit.captionPlan('x'.repeat(1025), { header: 'H' }), { caption: '', text: `H\n${'x'.repeat(1025)}` });
});

test('E3. Владелец в прежний диалог: настоящее client_dialog_messages + та же квитанция owner_requests + задание reply; файл читается по маршруту этого диалога; строгий ACK только для этого задания', async (t) => {
  const f = fixture(t);
  const dialog = legacyDialog(f);
  drainAll(f);
  const caption = 'С'.repeat(1100);
  const before = { thread: f.count('chat_thread_messages'), native: f.count('chat_native_jobs') };
  const up = ownerLegacyUpload(f, dialog.id, BYTES.pdf, { caption });
  assert.deepEqual([up.done.ok, up.done.duplicate, up.done.dialogId, up.done.deliveryStatus, up.done.upload.state], [true, false, dialog.id, 'pending', 'committed']);
  const message = f.db.prepare('SELECT * FROM client_dialog_messages WHERE id=?').get(up.done.messageId);
  assert.deepEqual([message.dialog_id, message.direction, message.author_type, message.text, message.delivery_status], [dialog.id, 'out', 'operator', caption, 'pending']);
  const jobId = Number(up.done.jobId.slice(3));
  const receipt = f.db.prepare('SELECT * FROM client_dialog_owner_requests WHERE job_id=?').get(jobId);
  assert.deepEqual([receipt.owner_user_id, receipt.message_id, receipt.request_id, receipt.dialog_id], [OWNER.id, message.id, up.requestId, dialog.id]);
  const job = f.db.prepare('SELECT * FROM client_bot_outbox WHERE id=?').get(jobId);
  const parts = JSON.parse(job.parts);
  assert.deepEqual([job.kind, job.dialog_id, job.message_id, job.operator_id, parts.map((p) => p.method)], ['reply', dialog.id, message.id, OPERATOR, ['sendMessage', 'sendDocument']]);
  assert.deepEqual([parts[0].params, parts[1].params], [{ chat_id: STRANGER, text: caption }, { chat_id: STRANGER }]);
  assert.deepEqual({ thread: f.count('chat_thread_messages'), native: f.count('chat_native_jobs') }, before, 'ни записи чата сайта, ни ложной связи chat_native_jobs');
  assert.equal(f.uploadRow(up.uuid).legacy_message_id, message.id);
  const view = f.dialogs.dialogView(SITE, dialog.id);
  assert.deepEqual(view.uploads, { enabled: true, maxBytes: 20 * MIB });
  const file = view.messages.find((m) => m.id === message.id).attachments[0];
  assert.deepEqual([file.id, file.ref, file.status, file.name], [up.ref, up.ref, 'stored', 'schet.pdf']);
  const bytes = await readProtected(() => f.dialogs.ownerUploadFile(SITE, dialog.id, up.uuid), (m) => f.dialogs.openOwnerUpload(m));
  assert.deepEqual([bytes.statusCode, Buffer.compare(bytes.body(), BYTES.pdf)], [200, 0]);
  const other = legacyDialog(f, '40004');
  assert.throws(() => f.dialogs.ownerUploadFile(SITE, other.id, up.uuid), (e) => e.status === 404, 'файл принадлежит именно своему диалогу');
  // Мост получает задание с безопасными сведениями о файле; строгий ACK: успех без номеров всех частей — не «доставлено».
  const [issued] = f.dialogs.pendingJobs(BOT);
  assert.deepEqual([issued.id, issued.parts[1].upload], [`cb:${jobId}`, { ref: up.ref, size: BYTES.pdf.length, sha256: sha(BYTES.pdf), name: 'schet.pdf', type: 'application/octet-stream' }]);
  assert.equal(f.dialogs.acknowledge(BOT, { jobId: issued.id, ok: true, externalMessageIds: ['9001'] }).status, 'uncertain');
  assert.equal(f.dialogs.acknowledge(BOT, { jobId: issued.id, ok: true, externalMessageIds: ['9001', '9002'] }).status, 'sent');
  assert.equal(f.db.prepare('SELECT delivery_status FROM client_dialog_messages WHERE id=?').get(message.id).delivery_status, 'sent');
  // Прежний текстовый ответ владельца — прежний нестрогий учёт (не тронут).
  const text = f.dialogs.sendOwnerReply(SITE, dialog.id, { requestId: crypto.randomUUID(), text: 'Обычный текст' }, OWNER);
  /* Repair S2 (фикстура): legacyDialog(f, '40004') выше поставил в очередь ещё и своё обычное задание (копию сообщения
     нового клиента менеджеру, номер раньше текстового ответа). pendingJobs выдаёт по одному заданию — самое раннее, поэтому
     первым приходит это прежнее задание: оно подтверждается как обычно, а задание текстового ответа ищется по его jobId. */
  let textJob = null;
  for (let guard = 0; guard < 10 && !textJob; guard += 1) {
    const jobs = f.dialogs.pendingJobs(BOT);
    if (!jobs.length) break;
    textJob = jobs.find((job) => job.id === text.jobId) || null;
    for (const job of jobs) if (job !== textJob) f.dialogs.acknowledge(BOT, { jobId: job.id, ok: true, externalMessageIds: job.parts.map(() => String(++externalId)) });
  }
  assert.ok(textJob, 'реальное задание текстового ответа найдено');
  assert.equal(textJob.id, text.jobId);
  assert.equal(f.dialogs.acknowledge(BOT, { jobId: textJob.id, ok: true, externalMessageIds: [] }).status, 'sent', 'старый legacy-ответ — как раньше');
});

/* ======================================================================================================
   2. Повторы, конфликты, проверка входа и доступа
   ====================================================================================================== */
test('E4. Тот же requestId: повтор подготовки — та же загрузка; другое содержимое/цель/текст — 409; потерянный ответ байтов — та же запись без второго файла и задания', async (t) => {
  const f = fixture(t);
  const bytes = png(10, 10);
  const requestId = crypto.randomUUID();
  const first = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(bytes, { requestId, caption: 'A' }) });
  const again = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(bytes, { requestId, caption: 'A' }) });
  assert.deepEqual([first.statusCode, again.statusCode, again.json().duplicate, again.json().upload.ref], [201, 200, true, first.json().upload.ref]);
  const ref = first.json().upload.ref;
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(bytes, { requestId, caption: 'B' }) })).statusCode, 409, 'другая подпись');
  const { thread: second } = f.core.createNewOrderThread(f.request, { orderId: 92 });
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${second.id}/uploads`, { json: prepareBody(bytes, { requestId, caption: 'A' }) })).statusCode, 409, 'другая цель');
  assert.throws(() => f.core.postWebMessage(f.request, { threadId: f.thread.id, requestId, text: 'Текст тем же requestId' }), (e) => e.status === 409, 'текст с requestId файла');
  const textId = crypto.randomUUID();
  f.core.postWebMessage(f.request, { threadId: f.thread.id, requestId: textId, text: 'Обычный текст' });
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(bytes, { requestId: textId }) })).statusCode, 409, 'файл с requestId текста');
  // Состояние — только чтение: ничего не меняется.
  const rowBefore = f.uploadRow(uploadKit.parseUploadRef(ref));
  const status = await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/uploads/${ref}`, { origin: null, csrf: '' });
  assert.deepEqual([status.json().upload.state, status.json().message], ['prepared', undefined]);
  assert.deepEqual(f.uploadRow(rowBefore.upload_uuid), rowBefore, 'GET status ничего не пишет');
  const sent = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${ref}/bytes`, { raw: bytes });
  const counts = () => ({ messages: f.count('chat_thread_messages'), jobs: f.count('client_bot_outbox'), files: f.files().length, requests: f.count('chat_thread_requests') });
  const after = counts();
  const lost = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${ref}/bytes`, { raw: bytes });
  assert.deepEqual([sent.statusCode, lost.statusCode, lost.json().duplicate, lost.json().message.id], [201, 200, true, sent.json().message.id]);
  assert.deepEqual(counts(), after, 'повтор не создаёт второго сообщения, файла и задания');
  const other = Buffer.from(bytes); other[other.length - 1] ^= 0xff;
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${ref}/bytes`, { raw: other })).statusCode, 409, 'другие байты под завершённой загрузкой');
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(bytes, { requestId, caption: 'A' }) })).json().message.id, sent.json().message.id,
    'подготовка тем же requestId после завершения — точная квитанция');
  // Владелец: одно пространство requestId текста и файла (чат сайта и прежние диалоги).
  const dialog = legacyDialog(f);
  const legacyText = crypto.randomUUID();
  f.dialogs.sendOwnerReply(SITE, dialog.id, { requestId: legacyText, text: 'Ответ' }, OWNER);
  assert.throws(() => ownerThreadUpload(f, bytes, { requestId: legacyText }), (e) => e.status === 409);
  const threadUp = ownerThreadUpload(f, bytes);
  assert.throws(() => f.dialogs.sendOwnerReply(SITE, dialog.id, { requestId: threadUp.requestId, text: 'Ответ' }, OWNER), (e) => e.status === 409);
  assert.throws(() => ownerLegacyUpload(f, dialog.id, bytes, { requestId: threadUp.requestId }), (e) => e.status === 409);
});

test('E5. Границы: пустой, 20 МБ+1, лишние поля, длинная подпись, путь в имени; байты не того размера/хеша — явный отказ и повтор теми же байтами; подмена типа — скачивание', async (t) => {
  const f = fixture(t);
  const post = (json) => f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json });
  const base = prepareBody(BYTES.pdf);
  for (const [body, status] of [[{ ...base, size: 0 }, 400], [{ ...base, size: 20 * MIB + 1 }, 413], [{ ...base, extra: 1 }, 400],
    [{ ...base, caption: 'x'.repeat(4001) }, 400], [{ ...base, requestId: base.requestId.toUpperCase() }, 400], [{ ...base, sha256: 'ab' }, 400],
    [{ ...base, name: 'a\u0000b.pdf' }, 400], [{ ...base, mime: 'image/png' }, 400], [{ requestId: base.requestId, name: 'a', size: 1, sha256: base.sha256 }, 400]]) {
    assert.equal((await post(body)).statusCode, status, JSON.stringify(Object.keys(body)));
  }
  assert.equal((await post({ ...prepareBody(BYTES.pdf), size: 20 * MIB })).statusCode, 201, 'ровно 20 МиБ — допустимо при подготовке');
  assert.deepEqual(uploadKit.prepareInput({ ...base, name: '..\\..\\etc/.passwd' }).name, 'passwd');
  const up = await post(prepareBody(BYTES.pdf, { name: 'doc.pdf' }));
  const ref = up.json().upload.ref, uuid = uploadKit.parseUploadRef(ref);
  const bytesPath = `/api/customer-chat/threads/${f.thread.id}/uploads/${ref}/bytes`;
  const wrong = Buffer.from(BYTES.pdf); wrong[20] ^= 1;
  const mismatch = await f.call('POST', bytesPath, { raw: wrong });
  assert.deepEqual([mismatch.statusCode, mismatch.json().code, f.uploadRow(uuid).state], [422, 'HASH_MISMATCH', 'prepared']);
  assert.equal(f.files().includes(f.uploadRow(uuid).disk_name), false, 'чужие байты не записаны');
  assert.equal((await f.call('POST', bytesPath, { raw: Buffer.concat([BYTES.pdf, Buffer.from('x')]) })).statusCode, 413, 'длиннее заявленного');
  assert.equal((await f.call('POST', bytesPath, { raw: BYTES.pdf.subarray(1) })).statusCode, 422, 'короче заявленного');
  assert.equal((await f.call('POST', bytesPath, { raw: BYTES.pdf, contentType: 'application/json' })).statusCode, 415);
  assert.equal((await f.call('POST', `${bytesPath}?x=1`, { raw: BYTES.pdf })).statusCode, 404, 'без query');
  assert.equal((await f.call('PUT', bytesPath, { raw: BYTES.pdf })).statusCode, 405);
  assert.equal((await f.call('POST', bytesPath, { raw: BYTES.pdf })).statusCode, 201, 'те же байты после отказов — завершено');
  for (const [bytes, name] of [[BYTES.svg, 'photo.jpg'], [BYTES.html, 'index.png']]) {
    const spoof = await buyerUpload(f, bytes, { name });
    const row = f.uploadRow(spoof.uuid);
    assert.deepEqual([row.kind, row.presentation, row.content_type], ['document', 'download', 'application/octet-stream'], name);
    const read = await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/attachments/${spoof.ref}`, { origin: null, csrf: '' });
    assert.deepEqual([read.headers['Content-Type'], /^attachment;/.test(read.headers['Content-Disposition']), read.headers['X-Content-Type-Options']], ['application/octet-stream', true, 'nosniff']);
  }
  const fake = await buyerUpload(f, png(5, 5), { name: 'program.exe' });
  assert.deepEqual([f.uploadRow(fake.uuid).kind, f.uploadRow(fake.uuid).presentation], ['photo', 'image'], 'тип — по байтам, не по имени');
  for (const bad of [`/api/customer-chat/threads/${f.thread.id}/uploads/upload:${uuid.toUpperCase()}/bytes`, `/api/customer-chat/threads/0${f.thread.id}/uploads`,
    `/api/customer-chat/threads/${f.thread.id}/uploads/upload:${uuid}/bytes/`, `/api/customer-chat/threads/${f.thread.id}/attachments/upload%3A${uuid}`,
    `/api/customer-chat/threads/${f.thread.id}/uploads/${uuid}`, `/api/customer-chat/threads/${f.thread.id}/attachments/upload:${uuid}/../x`]) {
    assert.equal((await f.call('POST', bad, { raw: BYTES.pdf })).statusCode, 404, bad);
  }
});

test('E6. Доступ: чужая сессия, чужой Origin, без CSRF; закрытая сессия и отозванный владелец после await — ни сообщения, ни файла, ни байтов', async (t) => {
  const f = fixture(t);
  const up = await buyerUpload(f, BYTES.pdf);
  const stranger = f.session();
  const strangerPrepare = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(BYTES.pdf), as: stranger });
  assert.equal(strangerPrepare.statusCode, 404, 'нет доступа к чату');
  assert.equal((await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/uploads/${up.ref}`, { as: stranger, origin: null, csrf: '' })).statusCode, 404);
  assert.equal((await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/attachments/${up.ref}`, { as: stranger, origin: null, csrf: '' })).statusCode, 404);
  assert.equal((await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/attachments/${up.ref}`, { origin: 'https://evil.example', csrf: '' })).statusCode, 403);
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(BYTES.pdf), origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(BYTES.pdf), csrf: '' })).statusCode, 403, 'без CSRF чата');
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(BYTES.pdf), origin: null })).statusCode, 403, 'запись без Origin');
  // Сессия закрыта, пока читалось тело: ни сообщения, ни файла; запись снова ждёт тех же байтов.
  const prepared = (await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(png(9, 9)) })).json();
  const uuid = uploadKit.parseUploadRef(prepared.upload.ref);
  const messages = f.count('chat_thread_messages');
  const revoked = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${prepared.upload.ref}/bytes`, { raw: png(9, 9), onRead: () => f.core.revokeWebSession(f.request) });
  assert.equal(revoked.statusCode, 401);
  assert.deepEqual([f.count('chat_thread_messages'), f.uploadRow(uuid).state, f.files().includes(f.uploadRow(uuid).disk_name)], [messages, 'prepared', false]);
  // Владелец отозван после начала приёма — завершения нет; отозван уже после записи файла — запись «готова», сообщения нет,
  // после восстановления доступа тот же UUID завершается один раз.
  const g = fixture(t);
  const prep = g.native.owner.prepareUpload({ owner: OWNER, threadId: g.thread.id, body: prepareBody(BYTES.pdf) });
  const id = uploadKit.parseUploadRef(prep.upload.ref);
  const begun = g.native.owner.beginUpload({ owner: OWNER, threadId: g.thread.id, uuid: id });
  g.owner.valid = false;
  assert.throws(() => g.native.owner.finishUpload({ owner: OWNER, threadId: g.thread.id, uuid: id, claim: begun.claim, bytes: BYTES.pdf }), (e) => e.status === 403);
  assert.deepEqual([g.uploadRow(id).state, g.count('chat_thread_messages')], ['prepared', 0]);
  g.owner.valid = true;
  const originalLink = fs.linkSync;
  fs.linkSync = (...args) => { const value = originalLink(...args); g.owner.valid = false; return value; };   // отзыв сразу после записи файла
  const again = g.native.owner.beginUpload({ owner: OWNER, threadId: g.thread.id, uuid: id });
  try { assert.throws(() => g.native.owner.finishUpload({ owner: OWNER, threadId: g.thread.id, uuid: id, claim: again.claim, bytes: BYTES.pdf }), (e) => e.status === 403); }
  finally { fs.linkSync = originalLink; }
  assert.deepEqual([g.uploadRow(id).state, g.count('chat_thread_messages'), g.files().length], ['ready', 0, 1], 'байты готовы и учтены, сообщения нет');
  assert.throws(() => g.native.owner.uploadStatus({ owner: OWNER, threadId: g.thread.id, uuid: id }), (e) => e.status === 403, 'отозванному — и чтения нет');
  g.owner.valid = true;
  assert.equal(g.native.owner.uploadStatus({ owner: OWNER, threadId: g.thread.id, uuid: id }).upload.state, 'ready');
  const third = g.native.owner.beginUpload({ owner: OWNER, threadId: g.thread.id, uuid: id });
  const done = g.native.owner.finishUpload({ owner: OWNER, threadId: g.thread.id, uuid: id, claim: third.claim || null, bytes: BYTES.pdf });
  assert.deepEqual([done.duplicate, done.upload.state, g.count('chat_thread_messages'), g.files().length], [false, 'committed', 1, 1]);
  assert.throws(() => g.native.owner.uploadFile({ owner: { id: 99, sessionVersion: 1 }, threadId: g.thread.id, uuid: id }), (e) => e.status === 403);
});

/* ======================================================================================================
   3. Сбои, перезапуск, общий предел, срок
   ====================================================================================================== */
test('E7. Сбой базы на итоговой записи, сбой записи файла и перезапуск: та же запись завершается тем же UUID один раз; файл не перезаписывается', async (t) => {
  const f = fixture(t);
  const bytes = png(30, 20);
  const prepared = (await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(bytes) })).json();
  const ref = prepared.upload.ref, uuid = uploadKit.parseUploadRef(ref);
  const bytesPath = `/api/customer-chat/threads/${f.thread.id}/uploads/${ref}/bytes`;
  let crashed = 0;
  f.db.prepare = function prepare(sql) {
    if (!crashed && /UPDATE chat_web_uploads SET state='committed'/.test(String(sql))) { crashed += 1; throw new Error('QA: сбой базы до commit'); }
    return DatabaseSync.prototype.prepare.call(this, sql);
  };
  const lost = await f.call('POST', bytesPath, { raw: bytes });
  delete f.db.prepare;
  assert.deepEqual([crashed, lost.statusCode], [1, 500]);
  const row = f.uploadRow(uuid);
  assert.deepEqual([row.state, row.thread_message_id, f.count('chat_thread_messages'), f.count('client_bot_outbox'), f.files()], ['ready', null, 0, 0, [row.disk_name]],
    'сообщение и задания откатились вместе, байты готовы под тем же именем');
  f.restart();
  assert.equal((await f.call('GET', `/api/customer-chat/threads/${f.thread.id}/uploads/${ref}`, { origin: null, csrf: '' })).json().upload.state, 'ready');
  const done = await f.call('POST', bytesPath, { raw: bytes });
  assert.deepEqual([done.statusCode, f.count('chat_thread_messages'), f.count('chat_native_jobs'), f.files()], [201, 1, 1, [row.disk_name]]);
  // Сбой записи файла: запись снова ждёт тех же байтов, файла нет; повтор — успех.
  const second = (await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(BYTES.pdf) })).json();
  const secondUuid = uploadKit.parseUploadRef(second.upload.ref);
  const originalLink = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('QA: диск'), { code: 'EIO' }); };
  let failed;
  try { failed = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${second.upload.ref}/bytes`, { raw: BYTES.pdf }); }
  finally { fs.linkSync = originalLink; }
  assert.deepEqual([failed.statusCode, f.uploadRow(secondUuid).state, f.files().includes(f.uploadRow(secondUuid).disk_name)], [500, 'prepared', false]);
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${second.upload.ref}/bytes`, { raw: BYTES.pdf })).statusCode, 201);
  // Сбой после записи файла, до «готово» (перезапуск в середине): приём просрочен → «uncertain»; те же байты переиспользуют файл.
  const third = (await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(BYTES.ogg) })).json();
  const thirdUuid = uploadKit.parseUploadRef(third.upload.ref);
  const scope = { threadId: f.thread.id, uuid: thirdUuid };
  f.core.beginWebUpload(f.request, scope);
  mediaKit.createMediaStorage({ root: f.storage }).put(f.uploadRow(thirdUuid).disk_name, BYTES.ogg);
  f.clock.t += 3 * 60 * 1000;
  f.restart();
  assert.equal(f.core.webUploadStatus(f.request, scope).upload.state, 'uncertain');
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${third.upload.ref}/bytes`, { raw: BYTES.ogg })).statusCode, 201);
  assert.equal(f.files().filter((name) => name === f.uploadRow(thirdUuid).disk_name).length, 1, 'один файл, не перезаписан');
});

test('E8. Общий предел L + D + E: резерв загрузки виден приёму Telegram (D) и прежним диалогам (L); замена резерва своими байтами; срок не «освобождает» записанные байты', async (t) => {
  const f = fixture(t, { maxStorage: 200 });
  f.receive(STRANGER, { document: { file_id: 'leg-40', file_name: 'l.bin' } });
  const legacyId = f.db.prepare('SELECT id FROM client_dialog_attachments ORDER BY id DESC LIMIT 1').get().id;
  const internalPost = async (id, bytes) => {
    const url = new URL(`http://content.internal/content/internal/client-bot/attachment?botKey=${BOT}&id=${id}`);
    let sent = null;
    await f.dialogs.handleInternal({ method: 'POST', headers: {} }, {}, url, { readJson: async () => ({}), readRaw: async () => bytes, send: (_r, status, payload) => { sent = { status, payload }; } });
    return sent;
  };
  assert.equal((await internalPost(String(legacyId), Buffer.alloc(40, 1))).payload.status, 'stored');
  const big = await buyerUpload(f, Buffer.concat([BYTES.pdf, Buffer.alloc(100 - BYTES.pdf.length, 2)]), { name: 'big.pdf' });   // 100 байт
  assert.equal(big.sent.statusCode, 201);
  const reserve = (await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(Buffer.alloc(50, 3)) })).json();   // 40 + 100 + резерв 50
  assert.equal(reserve.upload.state, 'prepared');
  const over = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(Buffer.alloc(11, 4)) });
  assert.deepEqual([over.statusCode, over.json().code], [409, 'QUOTA_EXCEEDED'], '40 + 100 + 50 + 11 > 200');
  f.claim();
  f.receive(CUSTOMER, { document: { file_id: 'tg-15', file_name: 'tg.bin', file_size: 15 } });
  assert.equal(f.db.prepare('SELECT status FROM chat_thread_attachments ORDER BY id DESC LIMIT 1').get().status, 'quota_exceeded', 'D видит E');
  f.receive(STRANGER, { document: { file_id: 'leg-15', file_name: 'l2.bin' } });
  const legacy15 = f.db.prepare('SELECT id FROM client_dialog_attachments ORDER BY id DESC LIMIT 1').get().id;
  assert.equal((await internalPost(String(legacy15), Buffer.alloc(15, 5))).payload.status, 'quota_exceeded', 'L видит E');
  // Резерв заменяется своими байтами (без двойного счёта): та же загрузка 50 байт завершается.
  const reserveRef = reserve.upload.ref;
  assert.equal((await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${reserveRef}/bytes`, { raw: Buffer.alloc(50, 3) })).statusCode, 201);
  // Незавершённая подготовка истекает: чтение лишь показывает «истекла», новая подготовка её закрывает и освобождает резерв.
  const stale = (await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(Buffer.alloc(9, 6)) })).json();
  const staleUuid = uploadKit.parseUploadRef(stale.upload.ref);
  f.clock.t += uploadKit.UPLOAD_TTL + 1000;
  f.beat();
  assert.deepEqual([f.core.webUploadStatus(f.request, { threadId: f.thread.id, uuid: staleUuid }).upload.state, f.uploadRow(staleUuid).state], ['expired', 'prepared'], 'GET только читает');
  const fresh = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(Buffer.alloc(9, 7)) });
  assert.deepEqual([fresh.statusCode, f.uploadRow(staleUuid).state, f.uploadRow(staleUuid).actual_size], [201, 'expired', null], 'без файла — резерв снят');
  const expiredBytes = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads/${stale.upload.ref}/bytes`, { raw: Buffer.alloc(9, 6) });
  assert.equal(expiredBytes.statusCode, 410, 'истёкшую запись не завершить');
  // Готовые, но не завершённые байты после срока остаются в учёте (файл не удаляется).
  const g = fixture(t, { maxStorage: 120 });
  const prep = g.native.owner.prepareUpload({ owner: OWNER, threadId: g.thread.id, body: prepareBody(Buffer.alloc(100, 8)) });
  const id = uploadKit.parseUploadRef(prep.upload.ref);
  const begun = g.native.owner.beginUpload({ owner: OWNER, threadId: g.thread.id, uuid: id });
  const originalLink = fs.linkSync;
  fs.linkSync = (...args) => { const value = originalLink(...args); g.owner.valid = false; return value; };
  try { assert.throws(() => g.native.owner.finishUpload({ owner: OWNER, threadId: g.thread.id, uuid: id, claim: begun.claim, bytes: Buffer.alloc(100, 8) })); }
  finally { fs.linkSync = originalLink; g.owner.valid = true; }
  g.clock.t += uploadKit.UPLOAD_TTL + 1000;
  g.beat();
  assert.throws(() => g.native.owner.prepareUpload({ owner: OWNER, threadId: g.thread.id, body: prepareBody(Buffer.alloc(30, 9)) }), (e) => e.code === 'QUOTA_EXCEEDED',
    'истёкшая готовая: 100 байт на диске по-прежнему в пределе');
  assert.deepEqual([g.native.owner.uploadStatus({ owner: OWNER, threadId: g.thread.id, uuid: id }).upload.state, g.uploadRow(id).actual_size, g.files().length], ['expired', 100, 1]);
  const small = g.native.owner.prepareUpload({ owner: OWNER, threadId: g.thread.id, body: prepareBody(Buffer.alloc(20, 9)) });
  assert.deepEqual([small.upload.state, g.uploadRow(id).state, g.uploadRow(id).actual_size], ['prepared', 'expired', 100], 'истечение записано, байты остались в учёте');
});

/* ======================================================================================================
   4. Внутренний upload-source для моста и проверка заданий перед выдачей
   ====================================================================================================== */
test('E9. upload-source: только выданное мосту задание, точная часть и ссылка; до выдачи, чужая часть, лишний параметр, подмена файла, смена менеджера — отказ', async (t) => {
  const f = fixture(t);
  const bytes = jpeg(800, 600, 2048);
  const up = await buyerUpload(f, bytes, { name: 'foto.jpg', caption: 'подпись' });
  const [job] = f.jobsOf(up.result.message.id);
  const jobRef = `cb:${job.id}`;
  const query = { jobId: jobRef, part: '1', ref: up.ref };
  assert.deepEqual([(await internalGet(f, '/upload-source', query)).status, (await internalGet(f, '/upload-source', query)).code], [409, 'NOT_CLAIMED'], 'до выдачи мосту');
  const [issued] = f.dialogs.pendingJobs(BOT);
  assert.equal(issued.id, jobRef);
  assert.deepEqual(issued.parts.map((p) => p.method), ['sendMessage', 'sendPhoto']);
  const source = await internalGet(f, '/upload-source', query);
  assert.deepEqual([source.status, Buffer.compare(source.body, bytes), source.headers['content-type'], source.headers['cache-control']], [200, 0, 'application/octet-stream', 'no-store']);
  assert.equal((await internalGet(f, '/upload-source', { ...query, part: '0' })).status, 404, 'текстовая часть — не файл');
  assert.equal((await internalGet(f, '/upload-source', { ...query, ref: `upload:${crypto.randomUUID()}` })).status, 404);
  assert.equal((await internalGet(f, '/upload-source', { ...query, extra: '1' })).status, 404, 'только точные параметры');
  assert.equal((await internalGet(f, '/upload-source', { ...query, jobId: 'cb:01' })).status, 404);
  f.recipient.chatId = '55555';
  assert.equal((await internalGet(f, '/upload-source', query)).status, 409, 'менеджер сменился — байтов нет');
  f.recipient.chatId = OPERATOR;
  const disk = path.join(f.storage, f.uploadRow(up.uuid).disk_name);
  const tampered = Buffer.from(bytes); tampered[100] ^= 1;
  fs.writeFileSync(disk, tampered);
  assert.equal((await internalGet(f, '/upload-source', query)).status, 404, 'подмена байтов того же размера не выдаётся');
  // Подмена описания файла в очереди останавливает задание до выдачи.
  const second = await buyerUpload(f, BYTES.pdf, { name: 'b.pdf' });
  const [row] = f.jobsOf(second.result.message.id);
  const parts = JSON.parse(row.parts);
  parts[1].upload.sha256 = '0'.repeat(64);
  f.db.prepare('UPDATE client_bot_outbox SET parts=? WHERE id=?').run(JSON.stringify(parts), row.id);
  f.dialogs.acknowledge(BOT, { jobId: jobRef, ok: false, retryable: false, error: 'QA' });
  assert.deepEqual(f.dialogs.pendingJobs(BOT), []);
  assert.equal(f.db.prepare('SELECT status FROM client_bot_outbox WHERE id=?').get(row.id).status, 'failed');
  // Метод выбирается по байтам и пределам фото Telegram заранее.
  assert.equal(uploadKit.telegramMethodOf({ type: 'image/png', size: 100, width: 6000, height: 4500 }), 'sendDocument', 'ширина + высота > 10000');
  assert.equal(uploadKit.telegramMethodOf({ type: 'image/png', size: 100, width: 6000, height: 4000 }), 'sendPhoto', 'ровно 10000 — ещё фото');
  assert.equal(uploadKit.telegramMethodOf({ type: 'image/png', size: 100, width: 2100, height: 100 }), 'sendDocument', 'соотношение > 20');
  assert.equal(uploadKit.telegramMethodOf({ type: 'image/jpeg', size: 10000001, width: 800, height: 600 }), 'sendDocument', '> 10 000 000 байт');
  assert.equal(uploadKit.telegramMethodOf({ type: 'image/jpeg', size: 10000000, width: 5000, height: 5000 }), 'sendPhoto');
  assert.equal(uploadKit.telegramMethodOf({ type: 'image/gif', size: 100, width: 10, height: 10 }), 'sendDocument');
  assert.deepEqual(uploadKit.imageSize(jpeg(800, 600), 'image/jpeg'), { width: 800, height: 600 });
  assert.deepEqual(uploadKit.imageSize(png(3, 7), 'image/png'), { width: 3, height: 7 });
  assert.equal(uploadKit.imageSize(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'), null);
});

test('E10. Выключатель загрузок: по умолчанию выкл — подготовка 409, выбора файла нет (uploads отсутствует), прежние тексты и чтения без изменений', async (t) => {
  const f = fixture(t, { uploadsEnabled: false });
  const res = await f.call('POST', `/api/customer-chat/threads/${f.thread.id}/uploads`, { json: prepareBody(BYTES.pdf) });
  assert.deepEqual([res.statusCode, res.json().code], [409, 'UPLOADS_DISABLED']);
  assert.equal(f.core.listWebMessages(f.request, { threadId: f.thread.id }).uploads, undefined, 'ответ истории — прежней формы');
  assert.throws(() => f.native.owner.prepareUpload({ owner: OWNER, threadId: f.thread.id, body: prepareBody(BYTES.pdf) }), (e) => e.code === 'UPLOADS_DISABLED');
  const dialog = legacyDialog(f);
  assert.throws(() => f.dialogs.prepareOwnerUpload(SITE, dialog.id, prepareBody(BYTES.pdf), OWNER), (e) => e.code === 'UPLOADS_DISABLED');
  assert.equal(f.dialogs.dialogView(SITE, dialog.id).uploads, undefined);
  assert.equal(f.core.postWebMessage(f.request, { threadId: f.thread.id, requestId: crypto.randomUUID(), text: 'Текст работает' }).ok, true);
  assert.equal(f.count('chat_web_uploads'), 0);
});
