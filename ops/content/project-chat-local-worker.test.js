'use strict';

/* Локальный обработчик Хью: ключ, область компаний, аренда, идемпотентный ACK, восстановление,
   смена режима, счётчики офлайна и очистка входа. Только встроенные модули Node:
   node --test ops/content/project-chat-local-worker.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const ROOM = 'palitra-love';
const OTHER = 'alvi';
const OWNER_ID = 1;
const WORKER_KEY = 'local-worker-key-0123456789abcdef';
const KEY_SHA = crypto.createHash('sha256').update(WORKER_KEY).digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
// Форма heartbeat настоящего Windows-обработчика (ops/local-hugh/status-file.js): safety — объект.
const SAFETY = { toolIsolationVerified: true, reason: 'proof_ok' };
const READY = { state: 'connected', authenticated: true, connected: true, available: true, limited: false, retryAfter: null,
  provider: 'codex', model: 'gpt-5-codex', safety: SAFETY, errorCode: null };
const LOGIN_NEEDED = { state: 'login_required', authenticated: false, connected: false, available: false, safety: SAFETY };
const near = (actual, expected, tolerance = 1500) => Math.abs(actual - expected) <= tolerance;
const OFFICIAL = 'https://auth.openai.com/codex/device';

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход в кабинет'), { status: 401 });
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) throw Object.assign(new Error('Некорректный CSRF-токен'), { status: 403 });
};
const sendJson = (response, status, payload, headers) => { response.statusCode = status; response.payload = payload; response.headers = headers; };
const readBody = async (request) => request.body;

function setup({ runtime = null, reply = null, local = [ROOM], trusted = [], key = KEY_SHA, db = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-local-'));
  const database = db || new DatabaseSync(':memory:');
  if (!db) database.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(database, `vlad:owner:${HASH}`);
  // Часы модуля идут вместе с реальными (сообщения ставятся по Date.now()), а тесты сдвигают их вперёд.
  const clock = { offset: 0, get now() { return Date.now() + this.offset; }, tick(ms) { this.offset += ms; } };
  const bodies = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = options.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/status')) {
      const value = typeof runtime === 'function' ? runtime() : runtime;
      if (!value) throw new Error('служба не отвечает');
      return { ok: true, status: 200, json: async () => value };
    }
    bodies.push(parsed);
    const value = (typeof reply === 'function' ? reply(parsed) : reply) || { status: 503 };
    return { ok: (value.status || 200) < 400, status: value.status || 200,
      headers: { get: () => null }, json: async () => value.payload ?? {} };
  };
  const chat = createProjectChat({ db: database, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080',
    chatApiKey: 'secret-key', requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl: 0,
    localWorker: { keySha256: key, companies: local, trustedAgentCompanies: trusted, now: () => clock.now } });
  const session = (id) => ({ user: authStore.getById(id), csrf: `csrf-${id}` });
  const person = (login, companies) => authStore.create(OWNER_ID, { login, displayName: login, password: 'x'.repeat(12), companies, permissions: [] }, HASH);
  return { db: database, authStore, chat, clock, bodies, session, person, owner: session(OWNER_ID) };
}

async function call(chat, { session = null, method = 'GET', url, body }) {
  const request = { method, headers: session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}, session, body };
  const response = { statusCode: 0, payload: null };
  await chat.handle(request, response, new URL(`http://x${url}`));
  return response;
}
const room = (suffix = '', code = ROOM) => `/content/project-chat/${code}${suffix}`;
const status = (value) => (error) => error.status === value;
const say = (chat, session, text, id, code = ROOM) =>
  call(chat, { session, method: 'POST', url: room('/messages', code), body: { text, clientMessageId: id } });

/* Запрос обработчика: Bearer-ключ, тело JSON, чтение тела фиксируется отдельно. */
async function worker(chat, route, body = {}, { key = WORKER_KEY, method = 'POST' } = {}) {
  let read = false;
  const raw = Buffer.from(JSON.stringify(body));
  const request = new Readable({ read() { read = true; this.push(raw); this.push(null); } });
  request.method = method;
  request.headers = key === null ? {} : { authorization: `Bearer ${key}` };
  const response = { statusCode: 0, payload: null, headers: null };
  try {
    await chat.localWorker.handle(request, response, new URL(`http://x/content/project-chat-worker/${route}`));
    return { ...response, read };
  } catch (error) { error.read = read; throw error; }
}
const jobs = (db, code = ROOM) => db.prepare('SELECT * FROM project_chat_ai_jobs WHERE company_code=? ORDER BY id').all(code);
const replies = (db) => db.prepare("SELECT count(*) AS n FROM project_chat_messages WHERE author_type='assistant'").get().n;
const ask = async (chat, owner, text = 'Хью, что со сроками?', id = `ask-${crypto.randomUUID()}`, code = ROOM) => {
  const posted = await say(chat, owner, text, id, code);
  assert.equal(posted.statusCode, 201);
  return posted.payload.message;
};
const bootUp = async (chat, boot = 'boot-1', runtimeStatus = READY) => {
  const beat = await worker(chat, 'heartbeat', { bootId: boot, status: runtimeStatus });
  assert.equal(beat.payload.ok, true);
  return beat.payload;
};
const claimReply = async (chat, boot = 'boot-1') => {
  const claimed = await worker(chat, 'claim', { bootId: boot });
  assert.ok(claimed.payload.job, 'ожидалось задание');
  return claimed.payload.job;
};
const complete = (chat, job, result, over = {}) => worker(chat, 'complete',
  { jobId: job.id, leaseToken: job.leaseToken, payloadHash: job.payloadHash, result, ...over });

test('ключ проверяется до чтения тела; без ключа, с чужим ключом и не-POST доступа нет', async () => {
  const { chat } = setup();
  for (const key of [null, 'wrong-key-0123456789abcdef', `${WORKER_KEY}x`, 'secret-key']) {
    await assert.rejects(() => worker(chat, 'claim', { bootId: 'b' }, { key }),
      (error) => error.status === 401 && error.read === false);
  }
  await assert.rejects(() => worker(chat, 'claim', { bootId: 'b' }, { method: 'GET' }), status(405));
  await assert.rejects(() => worker(chat, 'unknown', {}), status(404));
  await assert.rejects(() => worker(chat, 'claim', { bootId: '' }), status(400));
  // Ненастроенный или неверно заданный хеш закрывает доступ полностью и не ломает запуск.
  const unconfigured = setup({ key: '' });
  await assert.rejects(() => worker(unconfigured.chat, 'claim', { bootId: 'b' }), status(401));
  assert.ok(unconfigured.chat.localWorker.issues.some((issue) => issue.includes('без HUGH_LOCAL_WORKER_KEY_SHA256')));
  const broken = setup({ key: 'not-a-hash', local: [ROOM, 'nope'] });
  await assert.rejects(() => worker(broken.chat, 'claim', { bootId: 'b' }), status(401));
  assert.ok(broken.chat.localWorker.issues.some((issue) => issue.includes('hex SHA256')));
  assert.ok(broken.chat.localWorker.issues.some((issue) => issue.includes('"nope"')));
  assert.deepEqual(broken.chat.localWorker.companies, [ROOM]);
});

test('серверный обработчик не трогает задания local company: выборка, офлайн, лимит, восстановление, перезапуск', async () => {
  let runtime = null;
  const { chat, db, owner } = setup({ runtime: () => runtime,
    reply: () => ({ status: 200, payload: { text: 'Серверный ответ', provider: 'codex', model: 'gpt-5-codex' } }) });
  await ask(chat, owner, 'Хью, что со сроками?', 'local-0001', ROOM);
  await ask(chat, owner, 'Хью, что со сроками?', 'other-0001', OTHER);
  // Служба недоступна: чужое задание уходит в ожидание, local остаётся в очереди без изменений.
  await chat.processAIJobs();
  assert.equal(jobs(db, OTHER)[0].status, 'blocked');
  assert.deepEqual([jobs(db)[0].status, jobs(db)[0].attempts], ['pending', 0]);
  // Лимит подписки серверной службы: hold не касается local.
  runtime = { connected: true, authenticated: true, state: 'limited', retryAfter: 60 };
  await chat.processAIJobs();
  assert.equal(jobs(db)[0].status, 'pending');
  // Служба готова: восстановление blocked→pending и выборка обходят local, ответ уходит только чужому.
  runtime = { connected: true, authenticated: true, state: 'ready' };
  db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z'").run();
  await chat.processAIJobs();
  assert.equal(jobs(db, OTHER)[0].status, 'done');
  assert.deepEqual([jobs(db)[0].status, jobs(db)[0].attempts], ['pending', 0]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_messages WHERE author_type='assistant' AND company_code=?").get(ROOM).n, 0);
  // Перезапуск: running с арендой у local не сбрасывается, чужой running возвращается в очередь.
  await ask(chat, owner, 'Хью, ещё', 'other-0002', OTHER);
  db.prepare("UPDATE project_chat_ai_jobs SET status='running' WHERE reply_message_id IS NULL").run();
  // Историческое задание серверного пути: ожидание подключения с уже собранным запросом.
  const historic = await ask(chat, owner, 'Хью, а что с историей?', 'local-0002', ROOM);
  const prestored = JSON.stringify({ jobId: `project-chat:${jobs(db)[1].id}`, companyCode: ROOM, messages: [{ role: 'user', content: 'старый запрос' }], system: 'старая инструкция' });
  db.prepare("UPDATE project_chat_ai_jobs SET status='blocked',error='Хью пока не подключён',payload=?,next_attempt_at='2000-01-01T00:00:00.000Z' WHERE message_id=?")
    .run(prestored, historic.id);
  chat.startWorker(); chat.stopWorker();
  assert.equal(jobs(db)[0].status, 'running');
  assert.equal(jobs(db)[1].status, 'blocked');
  assert.equal(jobs(db, OTHER).at(-1).status, 'pending');
  // Снимок local company не опрашивает серверную службу и честно показывает офлайн компьютера.
  const view = await call(chat, { session: owner, url: room() });
  assert.deepEqual([view.payload.ai.local, view.payload.ai.offline, view.payload.ai.runtimeState, view.payload.ai.connected], [true, true, 'offline', false]);
  assert.equal(view.payload.ai.queued, 2);
  assert.equal(view.payload.ai.waiting, 1);
  assert.equal(view.payload.messages.at(-1).aiStatus, 'pending');
  // Повторный bootstrap: унаследованные running без аренды и blocked возобновляются по порядку,
  // а уже собранный запрос уходит без пересборки — байт в байт.
  await bootUp(chat);
  const job = await claimReply(chat);
  assert.equal(job.id, String(jobs(db)[0].id));
  await complete(chat, job, { ok: true, text: 'Первый ответ' });
  const resumed = await claimReply(chat);
  assert.equal(resumed.id, String(jobs(db)[1].id));
  assert.equal(resumed.payloadHash, sha256(prestored), 'сохранённый запрос не пересобран');
  assert.equal(resumed.payload.system, 'старая инструкция');
});

test('аренда, продление и подтверждение: ответ, отправка в Telegram и done одной транзакцией, повтор ACK идемпотентен', async () => {
  const { chat, db, owner, clock } = setup();
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { telegramChatId: '-1001' } });
  const question = await ask(chat, owner);
  const row = jobs(db)[0];
  // Без heartbeat и без готового runtime задания не выдаются.
  assert.deepEqual((await worker(chat, 'claim', { bootId: 'boot-1' })).payload, { job: null, retryAfter: 5 });
  await bootUp(chat, 'boot-1', { ...READY, authenticated: false });
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  await bootUp(chat, 'boot-1', { ...READY, limited: true, state: 'limited' });
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  // Одного available мало: без подтверждённой изоляции инструментов ответы не выдаются.
  await bootUp(chat, 'boot-1', { ...READY, safety: { toolIsolationVerified: false, reason: 'proof_missing' } });
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  await bootUp(chat, 'boot-1', { ...READY, safety: 'verified' });
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  const beat = await bootUp(chat);
  assert.deepEqual(Object.keys(beat).sort(), ['ok', 'serverTime', 'stats']);
  // Задание выдаётся только той загрузке, чей heartbeat подтвердил готовность.
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-other' })).payload.job, null);
  await bootUp(chat);
  const job = await claimReply(chat);
  assert.equal(job.kind, 'reply');
  assert.equal(job.companyCode, ROOM);
  assert.equal(job.id, String(row.id));
  assert.equal(job.payload.jobId, `project-chat:${job.id}`, 'номер задания совпадает с jobId запроса, как ждёт worker');
  assert.ok(job.payload.messages.at(-1).content.includes('Хью, что со сроками?'));
  const stored = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(row.id);
  assert.equal(job.payloadHash, sha256(stored.payload), 'хеш считается от сохранённой строки запроса');
  assert.equal(sha256(JSON.stringify(job.payload)), job.payloadHash, 'повторная сериализация даёт тот же хеш');
  assert.ok(near(Date.parse(job.leaseExpiresAt), clock.now + 180000));
  assert.deepEqual([stored.status, stored.attempts, stored.boot_id], ['running', 0, 'boot-1'], 'выдача попытку не расходует');
  // Одна активная аренда на обработчик.
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  // Повтор ответов владельцем не трогает выданное задание: аренда и токен остаются.
  const requeued = await call(chat, { session: owner, method: 'POST', url: room('/retry-ai'), body: {} });
  assert.equal(requeued.payload.requeued, 0);
  assert.deepEqual([jobs(db)[0].status, jobs(db)[0].lease_token], ['running', job.leaseToken]);
  clock.tick(20000);
  const renewed = await worker(chat, 'renew', { jobId: job.id, leaseToken: job.leaseToken });
  assert.equal(renewed.payload.ok, true);
  assert.ok(near(Date.parse(renewed.payload.leaseExpiresAt), clock.now + 180000));
  await assert.rejects(() => worker(chat, 'renew', { jobId: job.id, leaseToken: 'wrong-token-0123456789' }), status(409));
  await assert.rejects(() => worker(chat, 'renew', { jobId: '999', leaseToken: job.leaseToken }), status(404));
  // Смена режима ответов после выдачи не отменяет уже поставленный вопрос: он отвечается как есть.
  await call(chat, { session: owner, method: 'PATCH', url: room('/settings'), body: { replyMode: 'delegate' } });
  // Неверный хеш запроса и мусорный результат не принимаются.
  await assert.rejects(() => complete(chat, job, { ok: true, text: 'x' }, { payloadHash: sha256('другое') }), status(409));
  await assert.rejects(() => complete(chat, job, { ok: true, text: '' }), status(400));
  await assert.rejects(() => complete(chat, job, { ok: false, errorCode: 'WEIRD' }), status(400));
  await assert.rejects(() => complete(chat, job, { ok: true, text: 'x' }, { leaseToken: 'wrong-token-0123456789' }), status(409));
  assert.equal(replies(db), 0);
  const done = await complete(chat, job, { ok: true, text: 'Сроки: среда', provider: 'codex', model: 'gpt-5-codex' });
  assert.deepEqual([done.payload.ok, done.payload.status], [true, 'done']);
  const finished = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(row.id);
  assert.deepEqual([finished.status, finished.provider, finished.model], ['done', 'codex', 'gpt-5-codex']);
  assert.equal(finished.reply_message_id, done.payload.replyMessageId);
  assert.equal(replies(db), 1);
  const outbox = db.prepare('SELECT * FROM project_chat_outbox WHERE message_id=?').get(done.payload.replyMessageId);
  assert.equal(outbox?.chat_id, '-1001', 'ответ Хью встал в очередь Telegram той же транзакцией');
  // Повтор того же результата с тем же lease — 200 без второго сообщения; другой результат — 409.
  const again = await complete(chat, job, { ok: true, text: 'Сроки: среда', provider: 'codex', model: 'gpt-5-codex' });
  assert.deepEqual([again.statusCode, again.payload.ok, again.payload.duplicate], [200, true, true]);
  assert.equal(replies(db), 1);
  await assert.rejects(() => complete(chat, job, { ok: true, text: 'Другой ответ' }), status(409));
  await assert.rejects(() => worker(chat, 'renew', { jobId: job.id, leaseToken: job.leaseToken }), status(409));
  const view = await call(chat, { session: owner, url: room() });
  assert.equal(view.payload.messages.at(-1).text, 'Сроки: среда');
  assert.equal(view.payload.messages.find((m) => m.id === question.id).aiStatus, 'done');
  assert.deepEqual([view.payload.ai.connected, view.payload.ai.runtimeState, view.payload.ai.model], [true, 'connected', 'gpt-5-codex']);
  // Отвеченное задание больше не выдаётся.
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
});

test('истёкшая аренда: результат по старому токену принимается, пока аренду не заменили; после замены — 409', async () => {
  const { chat, db, owner, clock } = setup();
  await ask(chat, owner);
  await bootUp(chat);
  const first = await claimReply(chat);
  clock.tick(200000);
  // Аренда истекла, но задание не перевыдано: вычисленный ответ не теряется.
  const late = await complete(chat, first, { ok: true, text: 'Поздний, но верный ответ' });
  assert.equal(late.payload.status, 'done');
  assert.equal(replies(db), 1);

  await ask(chat, owner, 'Хью, а бюджет?', 'ask-budget');
  await bootUp(chat);
  const second = await claimReply(chat);
  clock.tick(200000);
  await bootUp(chat, 'boot-2');
  const reclaimed = await claimReply(chat, 'boot-2');
  assert.equal(reclaimed.id, second.id);
  assert.notEqual(reclaimed.leaseToken, second.leaseToken, 'повторная выдача меняет токен');
  assert.equal(db.prepare('SELECT attempts FROM project_chat_ai_jobs WHERE id=?').get(Number(second.id)).attempts, 0, 'истечение аренды попытку не расходует');
  await assert.rejects(() => complete(chat, second, { ok: true, text: 'Ответ старой загрузки' }), status(409));
  await assert.rejects(() => worker(chat, 'renew', { jobId: second.id, leaseToken: second.leaseToken }), status(409));
  assert.equal(replies(db), 1);
  const ok = await complete(chat, reclaimed, { ok: true, text: 'Ответ новой загрузки' });
  assert.equal(ok.payload.status, 'done');
  assert.equal(replies(db), 2);
  // Компьютер выключали трижды посреди работы: вопрос не сгорает и выдаётся снова с нулём попыток.
  await ask(chat, owner, 'Хью, третье', 'ask-third');
  for (let round = 0; round < 3; round++) { await bootUp(chat, `boot-${round + 3}`); await claimReply(chat, `boot-${round + 3}`); clock.tick(200000); }
  await bootUp(chat, 'boot-9');
  const survivor = await claimReply(chat, 'boot-9');
  assert.equal(survivor.id, String(jobs(db).at(-1).id));
  assert.deepEqual([jobs(db).at(-1).status, jobs(db).at(-1).attempts], ['running', 0]);
});

test('офлайн, вход и квота не расходуют попытки; терминальные отказы не повторяются сами', async () => {
  const { chat, db, owner, clock } = setup();
  await ask(chat, owner);
  const id = jobs(db)[0].id;
  await bootUp(chat);
  let job = await claimReply(chat);
  const limited = await complete(chat, job, { ok: false, errorCode: 'RATE_LIMITED', retryAfter: 120 });
  assert.deepEqual([limited.payload.status, limited.payload.retryAfter], ['blocked', 120]);
  let row = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
  assert.deepEqual([row.status, row.attempts], ['blocked', 0]);
  assert.match(row.error, /временно ограничена/);
  assert.ok(near(Date.parse(row.next_attempt_at), clock.now + 120000));
  // Повтор того же ACK — идемпотентно; до истечения паузы задание не выдаётся.
  assert.equal((await complete(chat, job, { ok: false, errorCode: 'RATE_LIMITED', retryAfter: 120 })).payload.duplicate, true);
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  const waiting = await call(chat, { session: owner, url: room() });
  assert.deepEqual([waiting.payload.ai.waiting, waiting.payload.ai.failed], [1, 0]);
  assert.equal(waiting.payload.messages.at(-1).aiStatus, 'pending');
  clock.tick(121000);
  await bootUp(chat);
  job = await claimReply(chat);
  assert.equal(job.id, String(id));
  for (const [code, pattern] of [['LOGIN_REQUIRED', /входа/], ['UNAVAILABLE', /недоступен/], ['BUSY', /занят/]]) {
    await complete(chat, job, { ok: false, errorCode: code });
    row = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
    assert.deepEqual([row.status, row.attempts], ['blocked', 0], code);
    assert.match(row.error, pattern);
    clock.tick(61000);
    await bootUp(chat);
    job = await claimReply(chat);
  }
  // Терминальный отказ: попытки исчерпаны сразу, вернуть может только владелец.
  await complete(chat, job, { ok: false, errorCode: 'SAFETY_REJECTED' });
  row = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
  assert.deepEqual([row.status, row.attempts], ['error', 3]);
  assert.match(row.error, /безопасности/);
  clock.tick(3600000);
  await bootUp(chat);
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  const failed = await call(chat, { session: owner, url: room() });
  assert.deepEqual([failed.payload.ai.failed, failed.payload.ai.failedJobIds], [1, [id]]);
  const requeued = await call(chat, { session: owner, method: 'POST', url: room('/retry-ai'), body: {} });
  assert.equal(requeued.payload.requeued, 1);
  job = await claimReply(chat);
  // Внутренняя ошибка считает попытки и после третьей останавливается.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await complete(chat, job, { ok: false, errorCode: 'INTERNAL_ERROR' });
    row = db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(id);
    assert.deepEqual([row.status, row.attempts], ['error', attempt]);
    clock.tick(200000);
    await bootUp(chat);
    const next = (await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job;
    if (attempt < 3) { assert.ok(next, `после попытки ${attempt} задание выдаётся снова`); job = next; }
    else assert.equal(next, null, 'после третьей попытки задание не выдаётся');
  }
  assert.match(row.error, /попытки исчерпаны/);
  assert.equal(replies(db), 0);
});

test('вход: одна устойчивая команда, выдача до авторизации, код только владельцу и только пока действует', async () => {
  const { chat, db, owner, person, session, clock } = setup();
  const daria = person('daria', [ROOM]);
  await call(chat, { session: owner, method: 'PUT', url: room('/members'), body: { userIds: [daria.id] } });
  const first = chat.localWorker.requestLogin(ROOM);
  assert.equal(first.accepted, true);
  assert.deepEqual([first.status.state, first.status.loginPending, first.status.local], ['offline', true, true]);
  assert.match(first.status.error, /ни разу не выходил на связь/);
  const second = chat.localWorker.requestLogin(ROOM);
  assert.equal(second.accepted, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_local_logins').get().n, 1, 'повторное нажатие не создаёт вторую команду');
  // Компьютер вышел на связь без входа: команда выдаётся, ответы — нет.
  await bootUp(chat, 'boot-1', LOGIN_NEEDED);
  assert.equal(chat.localWorker.ownerStatus(ROOM).state, 'login_pending');
  const job = await claimReply(chat);
  assert.deepEqual([job.kind, job.id, job.companyCode, job.payload, job.payloadHash], ['login', 'login:1', ROOM, {}, sha256('{}')]);
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null, 'одна аренда');
  // Чужая ссылка не проходит: кода владелец не увидит.
  const bogus = await complete(chat, job, { ok: true, status: { ...LOGIN_NEEDED, loginUrl: 'https://login.example.test/device', userCode: 'WXYZ-9999' } });
  assert.equal(bogus.payload.status, 'done');
  let mine = chat.localWorker.ownerStatus(ROOM);
  assert.deepEqual([mine.userCode, mine.loginUrl, mine.state], ['', '', 'login_required']);
  // Новая команда с официальной ссылкой: ссылка и код видны владельцу, TTL ограничен.
  chat.localWorker.requestLogin(ROOM);
  const again = await claimReply(chat);
  const expiresAt = new Date(clock.now + 3600000).toISOString();
  await complete(chat, again, { ok: true, status: { ...LOGIN_NEEDED, loginUrl: OFFICIAL, userCode: 'ABCD-1234', expiresAt,
    error: 'raw exception text', accessToken: 'secret-token' } });
  mine = chat.localWorker.ownerStatus(ROOM);
  assert.deepEqual([mine.state, mine.loginUrl, mine.userCode], ['login_required', OFFICIAL, 'ABCD-1234']);
  assert.ok(Date.parse(mine.expiresAt) <= clock.now + 15 * 60000, 'срок кода ограничен сервером');
  assert.ok(!JSON.stringify(mine).includes('secret-token') && !JSON.stringify(mine).includes('raw exception'));
  const reuse = chat.localWorker.requestLogin(ROOM);
  assert.deepEqual([reuse.accepted, reuse.status.userCode], [true, 'ABCD-1234']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_local_logins WHERE status IN ('pending','running')").get().n, 0, 'действующий код не создаёт новую команду');
  // Снимок комнаты не раскрывает ссылку и код ни владельцу, ни участнику.
  for (const who of [owner, session(daria.id)]) {
    const view = await call(chat, { session: who, url: room() });
    assert.ok(!JSON.stringify(view.payload).includes('ABCD-1234') && !JSON.stringify(view.payload).includes('auth.openai.com'));
    assert.equal(view.payload.ai.runtimeState, 'login_required');
  }
  // Новый запуск обработчика: код прежнего процесса недействителен и не воскресает.
  await bootUp(chat, 'boot-2', LOGIN_NEEDED);
  assert.equal(chat.localWorker.ownerStatus(ROOM).userCode, '');
  assert.equal(chat.localWorker.requestLogin(ROOM).status.state, 'login_pending', 'владелец запрашивает вход заново');
  const fresh = await claimReply(chat, 'boot-2');
  await complete(chat, fresh, { ok: true, status: { ...LOGIN_NEEDED, loginUrl: OFFICIAL, userCode: 'EFGH-5678', expiresAt } });
  assert.equal(chat.localWorker.ownerStatus(ROOM).userCode, 'EFGH-5678');
  // Просроченный код исчезает; подтверждённый вход очищает его и открывает ответы.
  clock.tick(16 * 60000);
  assert.equal(chat.localWorker.ownerStatus(ROOM).userCode, '');
  await bootUp(chat, 'boot-1', READY);
  mine = chat.localWorker.ownerStatus(ROOM);
  assert.deepEqual([mine.state, mine.connected, mine.authenticated, mine.userCode], ['connected', true, true, '']);
  assert.equal(db.prepare('SELECT login FROM project_chat_local_worker WHERE id=1').get().login, '{}');
  assert.equal(chat.localWorker.requestLogin(ROOM).accepted, false, 'при подтверждённом входе команда не нужна');
  // Неудачный вход: команда закрывается, владелец видит безопасную причину, автоповтора нет.
  await bootUp(chat, 'boot-1', LOGIN_NEEDED);
  chat.localWorker.requestLogin(ROOM);
  const failing = await claimReply(chat);
  await complete(chat, failing, { ok: false, errorCode: 'UNAVAILABLE', retryAfter: 30 });
  mine = chat.localWorker.ownerStatus(ROOM);
  assert.equal(mine.state, 'login_required');
  assert.match(mine.error, /Не удалось начать вход/);
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  await assert.rejects(() => worker(chat, 'renew', { jobId: 'login:1', leaseToken: job.leaseToken }), status(409));
});

test('heartbeat сохраняет только публичные поля и отдаёт метрики; смена состава компаний закрывает чужие задания', async () => {
  const shared = new DatabaseSync(':memory:');
  shared.exec('PRAGMA foreign_keys = ON;');
  const wide = setup({ db: shared, local: [ROOM, OTHER] });
  const beat = await worker(wide.chat, 'heartbeat', { bootId: 'boot-1', status: { ...READY, state: 'ready<script>', loginUrl: OFFICIAL,
    userCode: 'ZZZZ-9999', error: 'stack trace with secret', errorCode: 'WHATEVER', provider: 'codex;rm', safety: 'strict' } });
  const stored = JSON.parse(shared.prepare('SELECT status FROM project_chat_local_worker WHERE id=1').get().status);
  // Закрытый список полей статуса: два поля доверенного режима добавлены, посторонние по-прежнему отбрасываются.
  assert.deepEqual(Object.keys(stored).sort(), ['authenticated', 'available', 'connected', 'errorCode', 'limited', 'model', 'provider', 'readiness', 'retryAfter', 'safety', 'state', 'trustedAgent']);
  assert.deepEqual([stored.trustedAgent, stored.readiness], [false, ''], 'без явного объявления доверенный режим выключен');
  assert.deepEqual([stored.state, stored.errorCode, stored.provider, stored.safety], ['unknown', '', '', { toolIsolationVerified: false, reason: '' }]);
  assert.ok(!JSON.stringify(stored).includes('ZZZZ') && !JSON.stringify(stored).includes('secret'));
  assert.deepEqual(Object.keys(beat.payload.stats).sort(),
    ['aiRequestsWhileOffline24h', 'companies', 'humanMessagesWhileOffline24h', 'lastSeen', 'offline', 'oldestPendingAgeSeconds', 'pendingAi']);
  assert.deepEqual(Object.keys(beat.payload.stats.companies).sort(), [OTHER, ROOM]);
  assert.equal(beat.payload.stats.offline, false);
  await ask(wide.chat, wide.owner, 'Хью, что со сроками?', 'other-0001', OTHER);
  await bootUp(wide.chat);
  const job = await claimReply(wide.chat);
  assert.equal(job.companyCode, OTHER);
  // Тот же сервер, но компания вернулась на серверный путь: её аренду локальный обработчик не продлит и не закроет.
  const narrow = setup({ db: shared, local: [ROOM] });
  await assert.rejects(() => worker(narrow.chat, 'renew', { jobId: job.id, leaseToken: job.leaseToken }), status(403));
  await assert.rejects(() => complete(narrow.chat, job, { ok: true, text: 'Чужой ответ' }), status(403));
  assert.equal((await worker(narrow.chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  assert.equal(replies(shared), 0);
  // Серверный обработчик забирает компанию себе: задание переходит в его ожидание.
  await narrow.chat.processAIJobs();
  assert.equal(jobs(shared, OTHER)[0].status, 'blocked');
  assert.deepEqual(Object.keys((await worker(narrow.chat, 'heartbeat', { bootId: 'boot-1', status: READY })).payload.stats.companies), [ROOM]);
});

test('счётчики офлайна: с активации, по серверным часам, один учёт на сообщение, отдельно люди и запросы', async () => {
  const { chat, db, owner, clock } = setup();
  const stats = () => chat.localWorker.companyStats(ROOM);
  assert.ok(stats().activationAt, 'момент активации сохранён');
  assert.deepEqual([stats().offline, stats().lastSeen, stats().pendingAi], [true, null, 0]);
  const plain = await ask(chat, owner, 'Просто новость', 'off-0001');
  assert.deepEqual([stats().humanMessagesWhileOffline24h, stats().aiRequestsWhileOffline24h], [1, 0]);
  await ask(chat, owner, 'Хью, что со сроками?', 'off-0002');
  assert.deepEqual([stats().humanMessagesWhileOffline24h, stats().aiRequestsWhileOffline24h, stats().pendingAi], [2, 1, 1]);
  assert.ok(stats().oldestPendingAgeSeconds >= 0);
  // Повторный учёт того же сообщения и чужая компания не меняют счётчики.
  chat.localWorker.noteMessage(ROOM, plain.id, 'human', false);
  await ask(chat, owner, 'Хью, а у ALVI?', 'off-other', OTHER);
  assert.deepEqual([stats().humanMessagesWhileOffline24h, stats().aiRequestsWhileOffline24h], [2, 1]);
  // Компьютер на связи: новые сообщения не считаются офлайновыми.
  await bootUp(chat);
  await ask(chat, owner, 'Хью, снова', 'off-0003');
  assert.deepEqual([stats().offline, stats().humanMessagesWhileOffline24h, stats().aiRequestsWhileOffline24h, stats().pendingAi], [false, 2, 1, 2]);
  // Тишина дольше минуты — офлайн по серверным часам; окно счётчиков — сутки.
  clock.tick(61000);
  assert.equal(stats().offline, true);
  await ask(chat, owner, 'Ещё без компьютера', 'off-0004');
  assert.equal(stats().humanMessagesWhileOffline24h, 3);
  clock.tick(25 * 3600000);
  assert.deepEqual([stats().humanMessagesWhileOffline24h, stats().aiRequestsWhileOffline24h], [0, 0]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_local_offline_events').get().n, 4, 'история событий не удаляется');
  // Ответ Хью сам не считается человеческим сообщением.
  await bootUp(chat);
  const job = await claimReply(chat);
  clock.tick(61000);
  await complete(chat, job, { ok: true, text: 'Ответ' });
  assert.equal(stats().humanMessagesWhileOffline24h, 0);
});


/* Политика доверенного внешнего исполнителя. По умолчанию выключена: проверки прежние. */

// Статус внешнего коннектора: изоляция инструментов НЕ подтверждена, вход модели не заявлен.
const EXTERNAL = { state: 'connected', authenticated: false, connected: true, available: true, limited: false,
  provider: 'claude', model: '', trustedAgent: true, readiness: 'attested',
  safety: { toolIsolationVerified: false, reason: 'external_agent_unproven' } };

test('по умолчанию режим выключен: без proof заданий не получает ни Codex, ни внешний исполнитель', async () => {
  // Обычный Codex без подтверждённой изоляции — поведение прежнее.
  const codex = setup();
  await ask(codex.chat, codex.owner);
  await bootUp(codex.chat, 'boot-1', { ...READY, safety: { toolIsolationVerified: false, reason: '' } });
  const noJob = await worker(codex.chat, 'claim', { bootId: 'boot-1' });
  assert.equal(noJob.payload.job, null, 'без proof Codex заданий не получает');

  // Внешний исполнитель без серверного включения — тоже ничего, сколько бы он о себе ни заявлял.
  const external = setup();
  await ask(external.chat, external.owner);
  await bootUp(external.chat, 'boot-1', EXTERNAL);
  const denied = await worker(external.chat, 'claim', { bootId: 'boot-1' });
  assert.equal(denied.payload.job, null, 'поле trustedAgent само по себе ничего не включает');
  assert.deepEqual(external.chat.localWorker.trustedCompanies, []);
});

test('явное включение на сервере: внешний исполнитель получает свою компанию и отвечает ровно один раз', async () => {
  const { chat, db, owner, clock } = setup({ local: [ROOM, OTHER], trusted: [ROOM] });
  assert.ok(chat.localWorker.issues.some((issue) => issue.includes('Изоляция инструментов для них НЕ подтверждается')));
  await ask(chat, owner);
  await ask(chat, owner, 'Второй вопрос по другому проекту', 'ask-other', OTHER);
  // Группа проекта привязана: проверяем, что ответ уходит существующей исходящей очередью.
  db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run('-1001234567890', ROOM);
  await bootUp(chat, 'boot-1', EXTERNAL);

  const job = await claimReply(chat);
  assert.equal(job.companyCode, ROOM, 'чужая компания в доверенный режим не попадает');
  const done = await complete(chat, job, { ok: true, text: 'Ответ внешнего исполнителя', provider: 'claude', model: '' });
  assert.equal(done.payload.status, 'done');
  assert.equal(replies(db), 1);

  // Ответ ушёл в существующую исходящую очередь — второго отправителя нет.
  const outbox = db.prepare('SELECT count(*) AS n FROM project_chat_outbox WHERE message_id=?').get(done.payload.replyMessageId);
  assert.equal(outbox.n, 1, 'ровно одна запись в существующей очереди Telegram');

  // Повтор того же результата не создаёт второго сообщения.
  const again = await complete(chat, job, { ok: true, text: 'Ответ внешнего исполнителя', provider: 'claude', model: '' });
  assert.equal(again.payload.duplicate, true);
  assert.equal(replies(db), 1);

  // Задание второй компании остаётся нетронутым: область компаний режим не расширяет.
  assert.equal(jobs(db, OTHER).filter((row) => row.reply_message_id).length, 0);
  assert.equal(clock.offset, 0);
});

test('доверенный режим: устаревшая аренда и чужая компания отклоняются', async () => {
  const { chat, db, owner, clock } = setup({ local: [ROOM, OTHER], trusted: [ROOM] });
  await ask(chat, owner);
  await bootUp(chat, 'boot-1', EXTERNAL);
  const job = await claimReply(chat);

  // Аренда истекла, задание забрал другой запуск — прежний результат сервер не принимает.
  clock.tick(200 * 1000);
  await bootUp(chat, 'boot-2', EXTERNAL);
  const retaken = await claimReply(chat, 'boot-2');
  assert.notEqual(retaken.leaseToken, job.leaseToken);
  await assert.rejects(() => complete(chat, job, { ok: true, text: 'Поздний ответ', provider: 'claude', model: '' }), status(409));
  assert.equal(replies(db), 0);

  // Чужая компания: задания второй компании не выдаются вовсе.
  await ask(chat, owner, 'Вопрос другого проекта', 'ask-other-2', OTHER);
  const next = await worker(chat, 'claim', { bootId: 'boot-2' });
  assert.ok(!next.payload.job || next.payload.job.companyCode === ROOM);
});

test('доверенный режим виден владельцу честно и отключается снятием компании из списка', async () => {
  const on = setup({ trusted: [ROOM] });
  await bootUp(on.chat, 'boot-1', EXTERNAL);
  const view = on.chat.localWorker.ownerStatus(ROOM);
  assert.equal(view.mode, 'trusted-agent');
  assert.equal(view.toolIsolationVerified, false);
  assert.ok(view.notice.includes('Изоляция его инструментов не подтверждена'));
  assert.equal(view.error, '', 'исполнитель заявил готовность — ложной ошибки нет');

  // Отзыв доступа: компания убрана из конфигурации сервера, выдача прекращается сразу.
  const off = setup({ trusted: [] });
  await ask(off.chat, off.owner);
  await bootUp(off.chat, 'boot-1', EXTERNAL);
  const denied = await worker(off.chat, 'claim', { bootId: 'boot-1' });
  assert.equal(denied.payload.job, null);
  const offView = off.chat.localWorker.ownerStatus(ROOM);
  assert.equal(offView.mode, 'isolated-codex');
});

test('доверенный режим не подменяет вход Codex и требует заявленной готовности', async () => {
  const { chat, owner } = setup({ trusted: [ROOM] });
  await ask(chat, owner);
  // Исполнитель на связи, но готовность не заявлена — заданий нет.
  await bootUp(chat, 'boot-1', { ...EXTERNAL, readiness: '' });
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  // Заявка на доверие без available — тоже нет.
  await bootUp(chat, 'boot-1', { ...EXTERNAL, available: false });
  assert.equal((await worker(chat, 'claim', { bootId: 'boot-1' })).payload.job, null);
  // Поддельные ссылка и код входа Codex в статусе внешнего исполнителя не сохраняются.
  await bootUp(chat, 'boot-1', { ...EXTERNAL, state: 'login_required', loginUrl: OFFICIAL, userCode: 'AAAA-1111' });
  const view = chat.localWorker.ownerStatus(ROOM);
  assert.equal(view.userCode, '');
  assert.equal(view.loginUrl, '');
});

test('отзыв режима между claim и complete: результат по прежней политике не принимается, аренда сохраняется', async () => {
  const shared = new DatabaseSync(':memory:');
  shared.exec('PRAGMA foreign_keys = ON;');
  const on = setup({ db: shared, local: [ROOM], trusted: [ROOM] });
  await ask(on.chat, on.owner);
  await bootUp(on.chat, 'boot-1', EXTERNAL);
  const job = await claimReply(on.chat);
  const leaseBefore = shared.prepare('SELECT lease_token,lease_expires_at,lease_mode FROM project_chat_ai_jobs WHERE id=?').get(Number(job.id));
  assert.equal(leaseBefore.lease_mode, 'trusted-agent', 'режим аренды записан');

  // Владелец убрал компанию из списка: та же база, новая конфигурация сервера.
  const off = setup({ db: shared, local: [ROOM], trusted: [] });
  await assert.rejects(() => complete(off.chat, job, { ok: true, text: 'Ответ после отзыва', provider: 'claude', model: '' }), status(403));
  await assert.rejects(() => worker(off.chat, 'renew', { jobId: job.id, leaseToken: job.leaseToken }), status(403));
  assert.equal(replies(shared), 0, 'клиенту ничего не написано');
  const leaseAfter = shared.prepare('SELECT lease_token,lease_expires_at,lease_mode FROM project_chat_ai_jobs WHERE id=?').get(Number(job.id));
  assert.deepEqual(leaseAfter, leaseBefore, 'аренда сохранена, а не стёрта: задание вернётся в очередь по сроку');
});

test('внешний исполнитель не забирает вход изолированных компаний', async () => {
  const { chat, db } = setup({ local: [ROOM, OTHER], trusted: [ROOM] });
  // Владелец просит вход для изолированной компании.
  const requested = chat.localWorker.requestLogin(OTHER);
  assert.equal(requested.accepted, true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_local_logins WHERE status='pending'").get().n, 1);

  // Подключён внешний исполнитель: задание входа ему не выдаётся вовсе.
  await bootUp(chat, 'boot-1', EXTERNAL);
  const claimed = await worker(chat, 'claim', { bootId: 'boot-1' });
  assert.ok(!claimed.payload.job || claimed.payload.job.kind !== 'login', 'вход Codex внешнему исполнителю не выдаётся');
  assert.equal(db.prepare("SELECT count(*) AS n FROM project_chat_local_logins WHERE status='running'").get().n, 0);

  // Команда входа для доверенной компании не создаётся вовсе.
  const refused = chat.localWorker.requestLogin(ROOM);
  assert.equal(refused.accepted, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_chat_local_logins').get().n, 1);
});

test('владелец видит доверенный режим без признаков подписки Codex', async () => {
  const { chat } = setup({ local: [ROOM, OTHER], trusted: [ROOM] });
  chat.localWorker.requestLogin(OTHER);
  await bootUp(chat, 'boot-1', EXTERNAL);
  const view = chat.localWorker.ownerStatus(ROOM);
  assert.equal(view.connected, true, 'связь не зависит от входа в подписку');
  assert.equal(view.authenticated, false, 'ложного входа не заявляем');
  assert.equal(view.state, 'connected');
  assert.equal(view.error, '', 'команда входа другого проекта не мешает внешнему исполнителю');
  assert.deepEqual([view.loginPending, view.loginUrl, view.userCode, view.expiresAt], [false, '', '', '']);
  // Изолированная компания того же сервера продолжает жить по прежним правилам.
  const isolated = chat.localWorker.ownerStatus(OTHER);
  assert.equal(isolated.mode, 'isolated-codex');
  assert.equal(isolated.connected, false, 'внешний исполнитель не выдаёт себя за вошедший Codex');
  await bootUp(chat, 'boot-1', { ...EXTERNAL, readiness: '', authenticated: true, provider: '' });
  const unavailable = chat.localWorker.ownerStatus(ROOM);
  assert.equal(unavailable.connected, false, 'без readiness общая лента не обещает готовность');
  assert.equal(unavailable.authenticated, false);
  assert.equal(unavailable.provider, '', 'неизвестный провайдер не превращается в Codex');
  assert.equal(unavailable.state, 'unavailable');
  assert.doesNotMatch(unavailable.error, /Codex|вход|подписк/);
});
