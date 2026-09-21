'use strict';

/* Продолжение работы Хью без наших CLI: вертикальный срез существующего маршрута
   клиентского ответа. Проверяется отказ основной и обеих резервных моделей, бюджетный стоп,
   перезапуск, отсутствие дублей и изоляция компаний.
   Живых обращений нет: сеть подменена, ключи выдуманные, наружу ничего не уходит.
   Запуск: node --test ops/content/hugh-continuity.test.js */

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createAuthStore} = require('./auth-store');
const {createProjectChat} = require('./project-chat');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const OWNER_ID = 1;
const PILOT = 'alvi', SECOND = 'avokado';
const MANAGER_TASK = 'Ответить клиенту вручную: ИИ недоступен';
const ENV = {
  HUGH_FALLBACK_PROVIDERS: 'primary,reserve',
  HUGH_FALLBACK_PRIMARY_URL: 'https://primary.test/v1',
  HUGH_FALLBACK_PRIMARY_KEY: 'test-key-primary',
  HUGH_FALLBACK_PRIMARY_MODEL: 'configured-primary-model',
  HUGH_FALLBACK_RESERVE_URL: 'https://reserve.test/v1',
  HUGH_FALLBACK_RESERVE_KEY: 'test-key-reserve',
  HUGH_FALLBACK_RESERVE_MODEL: 'configured-reserve-model',
};

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход'), {status: 401});
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) {
    throw Object.assign(new Error('Некорректный CSRF-токен'), {status: 403});
  }
};
const sendJson = (response, status, payload, headers) => {
  response.statusCode = status; response.payload = payload; response.headers = headers;
};
const readBody = async (request) => request.body;

function setup(t, {env = {}, responder} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugh-continuity-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({url: String(url)});
    // Основной путь (собственный рантайм) считаем отключённым: именно это и происходит,
    // когда наши CLI выключены по лимитам.
    if (String(url).endsWith('/status')) throw new Error('рантайм не отвечает');
    return responder ? responder(calls.length) : {ok: false, status: 503,
      headers: {get: () => null}, json: async () => ({})};
  };
  const build = () => createProjectChat({db, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080',
    chatApiKey: 'secret-key', requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl: 0,
    fallback: {env: {...ENV, ...env}}});
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {db, authStore, chat: build(), rebuild: build, calls, dir,
    owner: {user: authStore.getById(OWNER_ID), csrf: `csrf-${OWNER_ID}`}};
}

async function post(chat, session, url, body) {
  const request = {method: 'POST', headers: {'x-csrf-token': session.csrf}, session, body};
  const response = {statusCode: 0, payload: null, headers: null,
    writeHead(status, head) { this.statusCode = status; this.headers = head; }, end() {}};
  await chat.handle(request, response, new URL(`http://x${url}`));
  return {statusCode: response.statusCode, payload: response.payload};
}
let asked = 0;
/* clientMessageId обязателен и защищает от дублей на входе. Задание модели ставится
   только по обращению к Хью по имени — так же, как в рабочем чате. */
const ask = (chat, owner, code, text, clientMessageId) => post(chat, owner,
  `/content/project-chat/${code}/messages`,
  {text: `Хью, ${text}`, clientMessageId: clientMessageId || `client-msg-${++asked}`});
const messages = (db, code) => db.prepare('SELECT * FROM project_chat_messages WHERE company_code=? ORDER BY id').all(code);
const tasks = (db, code) => db.prepare('SELECT * FROM project_chat_tasks WHERE company_code=? ORDER BY id').all(code);
const jobs = (db, code) => db.prepare('SELECT * FROM project_chat_ai_jobs WHERE company_code=? ORDER BY id').all(code);

test('отказ основной и обеих резервных моделей: вопрос ждёт, приём подтверждён, задача менеджеру заведена', async (t) => {
  const f = setup(t, {env: {HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '100'}});
  const asked = await ask(f.chat, f.owner, PILOT, 'Вопрос клиента про запись');
  assert.equal(asked.statusCode, 201);
  await f.chat.processAIJobs();

  const job = jobs(f.db, PILOT)[0];
  assert.equal(job.reply_message_id, null, 'ответа нет');
  assert.equal(job.status, 'blocked', 'вопрос остался в очереди, а не сгорел');
  assert.ok(job.attempts < 3, 'попытки не сожжены отказом провайдеров');

  const list = messages(f.db, PILOT);
  const ack = list.find((row) => row.author_type === 'assistant');
  assert.ok(ack, `подтверждение приёма не найдено: ${JSON.stringify(list.map((row) => [row.author_type, row.text]))}`);
  assert.match(ack.text, /сообщение получено и поставлено в очередь/);
  assert.match(ack.text, /Сейчас ответить не могу/);
  assert.doesNotMatch(ack.text, /Ответ провайдера/);

  const open = tasks(f.db, PILOT);
  assert.equal(open.length, 1);
  assert.equal(open[0].title, MANAGER_TASK);
  assert.equal(open[0].status, 'todo');

  // Повтор прохода не плодит ни подтверждений, ни задач.
  await f.chat.processAIJobs();
  assert.equal(tasks(f.db, PILOT).length, 1, 'вторая задача менеджеру не создана');
  assert.equal(messages(f.db, PILOT).filter((row) => row.author_type === 'assistant').length, 1);
});

test('бюджетный стоп не даёт ни одного платного обращения, вопрос всё равно сохранён', async (t) => {
  const f = setup(t, {env: {HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '1'},
    responder: () => ({ok: true, status: 200, headers: {get: () => null},
      json: async () => ({model: 'configured-primary-model', usage: {prompt_tokens: 5, completion_tokens: 5},
        choices: [{message: {content: 'Ответ модели'}}]})})});
  await ask(f.chat, f.owner, PILOT, 'Первый вопрос');
  await f.chat.processAIJobs();
  assert.ok(messages(f.db, PILOT).some((row) => row.text === 'Ответ модели'), 'первый вопрос отвечен');
  const providerCalls = f.calls.filter((call) => call.url.includes('chat/completions')).length;
  assert.equal(providerCalls, 1);

  // Граница достигнута: следующий вопрос платных обращений не порождает.
  await ask(f.chat, f.owner, PILOT, 'Второй вопрос');
  await f.chat.processAIJobs();
  assert.equal(f.calls.filter((call) => call.url.includes('chat/completions')).length, providerCalls,
    'после границы бюджета обращений нет');
  const waiting = jobs(f.db, PILOT).at(-1);
  assert.equal(waiting.reply_message_id, null);
  assert.equal(waiting.status, 'blocked');
  assert.equal(tasks(f.db, PILOT).length, 1, 'менеджеру заведена задача');
});

test('перезапуск сервиса: расход, очередь и задача сохраняются, дубля ответа нет', async (t) => {
  const f = setup(t, {env: {HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '1'},
    responder: () => ({ok: true, status: 200, headers: {get: () => null},
      json: async () => ({model: 'configured-primary-model', usage: {prompt_tokens: 5, completion_tokens: 5},
        choices: [{message: {content: 'Ответ модели'}}]})})});
  await ask(f.chat, f.owner, PILOT, 'Первый вопрос');
  await f.chat.processAIJobs();
  await ask(f.chat, f.owner, PILOT, 'Второй вопрос');
  await f.chat.processAIJobs();
  const before = messages(f.db, PILOT).length, callsBefore = f.calls.length;

  // Перезапуск: новый экземпляр на той же базе.
  const restarted = f.rebuild();
  await restarted.processAIJobs();
  assert.equal(f.calls.length, callsBefore + 1, 'только проверка рантайма, платных обращений нет');
  assert.equal(messages(f.db, PILOT).length, before, 'дубля ответа и подтверждения нет');
  assert.equal(messages(f.db, PILOT).filter((row) => row.text === 'Ответ модели').length, 1);
  assert.equal(tasks(f.db, PILOT).length, 1);
  const stored = jobs(f.db, PILOT);
  assert.equal(stored[0].reply_message_id !== null, true, 'готовый ответ пережил перезапуск');
  assert.equal(stored[1].reply_message_id, null, 'ждущий вопрос пережил перезапуск');
});

test('ожидание одной компании не создаёт подтверждений и задач в другой', async (t) => {
  const f = setup(t, {env: {HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '100'}});
  await ask(f.chat, f.owner, PILOT, 'Вопрос только этой компании');
  await f.chat.processAIJobs();
  assert.equal(tasks(f.db, PILOT).length, 1);
  assert.equal(tasks(f.db, SECOND).length, 0, 'у второй компании задач нет');
  assert.equal(messages(f.db, SECOND).length, 0, 'у второй компании сообщений нет');
  assert.equal(jobs(f.db, SECOND).length, 0);
  assert.doesNotMatch(JSON.stringify(messages(f.db, SECOND)), /Вопрос только этой компании/);

  // Вопрос второй компании ведёт себя так же и не смешивается с первой.
  await ask(f.chat, f.owner, SECOND, 'Вопрос второй компании');
  await f.chat.processAIJobs();
  assert.equal(tasks(f.db, SECOND).length, 1);
  assert.equal(tasks(f.db, PILOT).length, 1, 'у первой компании задача не удвоилась');
  assert.doesNotMatch(JSON.stringify(messages(f.db, PILOT)), /Вопрос второй компании/);
});

test('после восстановления провайдера ждущий вопрос отвечается без повторной задачи', async (t) => {
  let alive = false;
  const f = setup(t, {env: {HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '100'},
    responder: () => (alive
      ? {ok: true, status: 200, headers: {get: () => null},
        json: async () => ({model: 'configured-primary-model', usage: {prompt_tokens: 5, completion_tokens: 5},
          choices: [{message: {content: 'Ответ после восстановления'}}]})}
      : {ok: false, status: 503, headers: {get: () => null}, json: async () => ({})})});
  await ask(f.chat, f.owner, PILOT, 'Вопрос во время сбоя');
  await f.chat.processAIJobs();
  assert.equal(jobs(f.db, PILOT)[0].status, 'blocked');
  assert.equal(tasks(f.db, PILOT).length, 1);

  // Провайдер поднялся; пауза провайдеров и срок ожидания истекли.
  alive = true;
  f.db.prepare("UPDATE project_chat_provider_state SET cooldown_until=NULL WHERE provider NOT LIKE 'ack:%'").run();
  f.db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at=? WHERE reply_message_id IS NULL")
    .run(new Date(Date.now() - 1000).toISOString());
  await f.chat.processAIJobs();
  const answered = messages(f.db, PILOT).some((row) => row.text === 'Ответ после восстановления');
  assert.equal(answered, true, 'вопрос дождался ответа, а не потерялся');
  assert.equal(tasks(f.db, PILOT).length, 1, 'вторая задача менеджеру не появилась');
});

/* Снимок комнаты читается обычным GET: post здесь не подходит, метод не тот. */
async function snapshotOf(chat, session, code = 'alvi') {
  const request = {method: 'GET', headers: {}, session};
  const response = {statusCode: 0, payload: null,
    writeHead(status) { this.statusCode = status; }, end() {}};
  await chat.handle(request, response, new URL(`http://x/content/project-chat/${code}`));
  return {statusCode: response.statusCode, payload: response.payload};
}

/* «Доступно 0» без причины — это час потерянного времени: провайдер числится настроенным
   и молчит, а откуда молчание, узнать неоткуда. Причина берётся у бюджета и провайдеров. */
test('снимок называет причину, когда доступных резервов не осталось', async (t) => {
  const {chat, owner} = setup(t, {env: {HUGH_FALLBACK_BUDGET_USD: '10'}});
  const view = await snapshotOf(chat, owner);
  const fallback = view.payload.ai.fallback;
  assert.equal(fallback.configured, true);
  assert.equal(fallback.available, 2, 'оба провайдера настроены и доступны');
  assert.equal(fallback.stoppedReason, '', 'при доступных резервах причина не выдумывается');
});

test('неверно заданные границы видны в снимке причиной, а не нулём без объяснения', async (t) => {
  const {chat, owner} = setup(t, {env: {HUGH_FALLBACK_BUDGET_USD: 'не число'}});
  const view = await snapshotOf(chat, owner);
  const fallback = view.payload.ai.fallback;
  assert.equal(fallback.available, 0);
  assert.match(fallback.stoppedReason, /границ|бюджет/i);
});
