'use strict';

/* Навык в рабочем маршруте ответа: инструкции должны попадать в собранный запрос ДО обращения,
   поэтому их видит и основной путь, и резерв — оба читают один payload.
   Живых обращений нет: сеть подменена, ключи выдуманные.
   Запуск: node --test ops/content/agent-skills-runtime.test.js */

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createAuthStore} = require('./auth-store');
const {createProjectChat} = require('./project-chat');
const {createAgentSkills} = require('./agent-skills');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const PILOT = 'alvi', SECOND = 'avokado';
const ENV = {
  HUGH_FALLBACK_PROVIDERS: 'primary',
  HUGH_FALLBACK_PRIMARY_URL: 'https://primary.test/v1',
  HUGH_FALLBACK_PRIMARY_KEY: 'test-key-primary',
  HUGH_FALLBACK_PRIMARY_MODEL: 'configured-primary-model',
  HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '100',
};
const CONTENT_ASK = 'подготовь контент-план на месяц: рубрики, рилсы и сторис по неделям';
const PLAIN_ASK = 'когда оплатим счёт за поставку, документы уже отправили?';

const requireSession = (request) => {
  if (!request.session) throw Object.assign(new Error('Требуется вход'), {status: 401});
  return request.session;
};
const requireCsrf = (request, session) => {
  if (String(request.headers['x-csrf-token'] || '') !== session.csrf) {
    throw Object.assign(new Error('Некорректный CSRF-токен'), {status: 403});
  }
};
const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
const readBody = async (request) => request.body;

function setup(t, {skills} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-runtime-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const sent = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/status')) throw new Error('рантайм не отвечает');
    if (String(url).includes('/chat/completions')) sent.push(JSON.parse(String(options.body || '{}')));
    return {ok: true, status: 200, headers: {get: () => null},
      json: async () => ({model: 'configured-primary-model', usage: {prompt_tokens: 5, completion_tokens: 5},
        choices: [{message: {role: 'assistant', content: 'Ответ модели'}}]})};
  };
  const chat = createProjectChat({db, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080',
    chatApiKey: 'secret-key', requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl: 0,
    fallback: {env: ENV}, ...(skills ? {skills} : {})});
  t.after(() => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  return {db, chat, sent, owner: {user: authStore.getById(1), csrf: 'csrf-1'}};
}

let counter = 0;
async function ask(f, code, text) {
  const request = {method: 'POST', headers: {'x-csrf-token': f.owner.csrf}, session: f.owner,
    body: {text: `Хью, ${text}`, clientMessageId: `client-${++counter}`}};
  const response = {statusCode: 0, payload: null, writeHead() {}, end() {}};
  await f.chat.handle(request, response, new URL(`http://x/content/project-chat/${code}/messages`));
  assert.equal(response.statusCode, 201, `сообщение не принято: ${JSON.stringify(response.payload)}`);
  await f.chat.processAIJobs();
}
const systemOf = (f, index = 0) => String(f.sent[index]?.messages?.[0]?.content || '');

test('контентное задание уносит инструкции навыка в реальный запрос', async (t) => {
  const f = setup(t);
  await ask(f, PILOT, CONTENT_ASK);
  assert.equal(f.sent.length, 1, 'запрос к провайдеру собран один раз');
  const system = systemOf(f);
  assert.equal(f.sent[0].messages[0].role, 'system');
  assert.match(system, /Ты Хью, бизнес-ассистент/, 'базовые правила остались на месте');
  assert.match(system, /навык synapse-content-system, версия 1\.0\.0/);
  assert.match(system, /роль/i);
  // Порядок: базовые правила, затем контекст проекта, затем навык. Навык правил не отменяет.
  assert.ok(system.indexOf('Ты Хью') < system.indexOf('навык synapse-content-system'));
  assert.ok(system.indexOf('задачи проекта') < system.indexOf('навык synapse-content-system')
    || system.includes('Этапы и задачи проекта пока не заведены'));
  // Навык не выдаёт разрешений — это едет тем же текстом, что и инструкция.
  assert.match(system, /не выдаёт доступов, не подтверждает согласование, не разрешает публикацию и не меняет бюджет/);
});

test('обычный вопрос не тянет навык в запрос', async (t) => {
  const f = setup(t);
  await ask(f, PILOT, PLAIN_ASK);
  const system = systemOf(f);
  assert.match(system, /Ты Хью, бизнес-ассистент/);
  assert.equal(system.includes('synapse-content-system'), false, 'нецелевая задача навык не подключает');
  assert.equal(system.includes('Рабочая инструкция'), false);
});

test('навык каждой компании ограничен её проектом', async (t) => {
  const f = setup(t);
  await ask(f, PILOT, CONTENT_ASK);
  await ask(f, SECOND, CONTENT_ASK);
  assert.equal(f.sent.length, 2);
  const first = systemOf(f, 0), second = systemOf(f, 1);
  assert.match(first, new RegExp(`проект компании ${PILOT}`));
  assert.equal(first.includes(SECOND), false, 'в запросе одной компании нет кода другой');
  assert.match(second, new RegExp(`проект компании ${SECOND}`));
  assert.equal(second.includes(PILOT), false);
});

test('выключенный загрузчик оставляет прежний запрос, ответ всё равно приходит', async (t) => {
  const f = setup(t, {skills: createAgentSkills({env: {HUGH_SKILLS: 'off'}, logger: {info() {}}})});
  await ask(f, PILOT, CONTENT_ASK);
  const system = systemOf(f);
  assert.equal(system.includes('synapse-content-system'), false);
  assert.match(system, /Ты Хью, бизнес-ассистент/);
  const replies = f.db.prepare(`SELECT count(*) AS n FROM project_chat_messages
    WHERE company_code=? AND author_type='assistant'`).get(PILOT).n;
  assert.equal(replies, 1, 'без навыка маршрут ответа работает как прежде');
});

test('сломанный загрузчик не ломает чат: запрос собирается без навыка', async (t) => {
  const broken = {status() { throw new Error('каталог недоступен'); },
    instructions() { throw new Error('каталог недоступен'); }};
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const f = setup(t, {skills: broken});
    await ask(f, PILOT, CONTENT_ASK);
    assert.equal(f.sent.length, 1, 'запрос всё равно ушёл');
    assert.match(systemOf(f), /Ты Хью, бизнес-ассистент/);
  } finally { console.error = original; }
  assert.ok(errors.some((line) => /навык не подключён/.test(line)), 'отказ загрузчика записан в журнал');
});

test('владелец видит идентификатор и версию навыка, содержание не показывается', async (t) => {
  const f = setup(t);
  const response = {statusCode: 0, payload: null, writeHead() {}, end() {}};
  await f.chat.handle({method: 'GET', headers: {}, session: f.owner}, response,
    new URL(`http://x/content/project-chat/${PILOT}`));
  assert.equal(response.statusCode, 200);
  const state = response.payload?.ai?.fallback?.skills;
  assert.ok(state, 'состояние навыков доступно владельцу');
  assert.equal(state.enabled, true);
  assert.deepEqual(state.skills, [{id: 'synapse-content-system', version: '1.0.0'}]);
  assert.equal(/Рабочая инструкция|роль публикации/i.test(JSON.stringify(state)), false,
    'содержание навыка в состоянии не показывается');
});
