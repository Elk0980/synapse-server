'use strict';

/* Настоящая интеграция личной переписки с приватным рантаймом: запрос уходит по HTTP
   в реальный обработчик рантайма с его реальным проверяющим тела и реальным хранилищем
   заданий. Подменена только модель — сеть наружу не используется, подписка не трогается.

   Ради чего тест: раньше личная переписка добавляла в тело поле audience, а проверяющий
   рантайма его не знал и отвергал каждый запрос. Заглушка ask этого не показывала.

   Запуск: node --test ops/content/owner-private-runtime.test.js */

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');
const { createOwnerPrivateChat } = require('./owner-private-chat');
const { createHttpServer } = require('../hugh-runtime/http-server');
const { createJobStore } = require('../hugh-runtime/job-store');
const { scopeKeyOf } = require('../hugh-runtime/limits');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const KEY = 'runtime-test-key';
const PILOT = 'alvi';
const SECRET = 'Личный вопрос владельца про проект';
const silent = { info() {}, warn() {}, error() {} };

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход'), { status: 401 });
  return request.session;
};
const requireCsrf = () => {};
const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
const readBody = async (request) => request.body;

async function setup(t, { reply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-runtime-'));
  // Настоящее хранилище заданий рантайма и настоящий HTTP-обработчик; подменена только модель.
  const seen = [];
  const store = createJobStore(path.join(dir, 'runtime.sqlite'));
  const runtime = { async reply(payload) {
    seen.push(payload);
    if (reply) return reply(payload, seen.length);
    return { text: `Ответ модели на «${payload.messages[payload.messages.length - 1].content}»`, model: 'stub-model' };
  } };
  const server = createHttpServer({ runtime, store, apiKey: KEY, logger: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runnerUrl = `http://127.0.0.1:${server.address().port}`;

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl, chatApiKey: KEY,
    requireSession, requireCsrf, sendJson, readBody, statusTtl: 0, fallback: { env: {} } });
  const priv = createOwnerPrivateChat({ db, authStore, requireSession, requireCsrf, sendJson, readBody,
    ask: (payload) => chat.askHugh(JSON.stringify(payload)) });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close(); store.close?.(); fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, chat, priv, store, seen, runnerUrl,
    owner: { user: authStore.getById(1), csrf: 'csrf-1' } };
}

async function say(priv, session, code, text, requestId) {
  const request = { method: 'POST', headers: { 'x-csrf-token': session.csrf }, session,
    body: requestId ? { text, requestId } : { text } };
  const response = { statusCode: 0, payload: null };
  try {
    await priv.handle(request, response, new URL(`http://x/content/owner-chat/${code}/messages`));
    return { statusCode: response.statusCode, payload: response.payload, error: null };
  } catch (error) { return { statusCode: error.status || 500, payload: null, error }; }
}

test('личный запрос проходит настоящую проверку тела рантайма и возвращает ответ модели', async (t) => {
  const f = await setup(t);
  const sent = await say(f.priv, f.owner, PILOT, SECRET);
  assert.equal(sent.statusCode, 201, `рантайм отверг личный запрос: ${sent.error?.message}`);
  // Проверяющий рантайма принял поле audience и донёс его до обработчика.
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].audience, 'owner-private');
  assert.equal(f.seen[0].companyCode, PILOT);
  assert.equal(scopeKeyOf(f.seen[0].companyCode, f.seen[0].audience), `${PILOT}#owner-private`);
  assert.match(f.seen[0].system, /личная переписка владельца/i);
  assert.deepEqual(f.seen[0].messages.map((m) => m.content), [SECRET]);
  const texts = sent.payload.messages.map((m) => m.text);
  assert.equal(texts[0], SECRET);
  assert.match(texts[1], /Ответ модели/);
});

test('область заданий рантайма отделена: общий чат не получает личный кэш и наоборот', async (t) => {
  const f = await setup(t);
  await say(f.priv, f.owner, PILOT, SECRET);
  const privateJob = f.seen[0];

  // Тот же jobId и та же компания, но общая аудитория — это другое задание, а не готовый ответ.
  const shared = await f.chat.askHugh(JSON.stringify({
    jobId: privateJob.jobId, companyCode: PILOT,
    system: 'Общий чат проекта.', messages: [{ role: 'user', content: 'Вопрос клиента' }] }));
  assert.equal(f.seen.length, 2, 'общий запрос выполнен заново, а не взят из личного кэша');
  
  assert.equal(shared.text.includes(SECRET), false, 'ответ общего чата не содержит личного текста');

  // В хранилище рантайма это две разные записи с разными ключами области.
  const scopes = f.seen.map((item) => scopeKeyOf(item.companyCode, item.audience));
  assert.deepEqual([...new Set(scopes)].sort(), [PILOT, `${PILOT}#owner-private`]);
});

test('повтор того же личного вопроса берёт готовый ответ рантайма, не запуская модель заново', async (t) => {
  const f = await setup(t, { reply: (payload, index) => ({ text: `Ответ №${index}`, model: 'stub-model' }) });
  const first = await say(f.priv, f.owner, PILOT, SECRET, 'req-1');
  assert.equal(first.statusCode, 201);
  // Тот же вопрос под тем же ключом: рантайм отдаёт сохранённый ответ.
  const { jobId, companyCode, audience, system, messages } = f.seen[0];
  const direct = await f.chat.askHugh(JSON.stringify({ jobId, companyCode, audience, system, messages }));
  assert.equal(f.seen.length, 1, 'модель второй раз не запускалась');
  assert.equal(direct.text, 'Ответ №1');
});

test('старое тело без audience рантайм принимает по-прежнему', async (t) => {
  const f = await setup(t);
  const legacy = await f.chat.askHugh(JSON.stringify({
    jobId: 'project-chat:1', companyCode: PILOT,
    system: 'Общий чат проекта.', messages: [{ role: 'user', content: 'Вопрос клиента' }] }));
  assert.match(legacy.text, /Ответ модели/);
  assert.equal(f.seen[0].audience, 'client-shared', 'тело без audience читается как общий чат');
  assert.equal(scopeKeyOf(f.seen[0].companyCode, f.seen[0].audience), PILOT,
    'ключ области прежний, сохранённые задания находятся');
});

test('непонятная аудитория отвергается рантаймом', async (t) => {
  const f = await setup(t);
  await assert.rejects(() => f.chat.askHugh(JSON.stringify({
    jobId: 'job-x', companyCode: PILOT, audience: 'кто-угодно',
    system: 'Проба.', messages: [{ role: 'user', content: 'Проба' }] })));
  assert.equal(f.seen.length, 0, 'до модели такой запрос не доходит');
});
