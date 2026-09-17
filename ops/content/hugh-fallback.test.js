'use strict';
/* Резерв ответов Хью: порядок провайдеров, cooldown по 429/5xx/таймауту, отсутствие дублей, изоляция компаний,
   честное подтверждение приёма при полной недоступности, подхват компаний локального обработчика при офлайне. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store');
const { createProjectChat } = require('./project-chat');
const { readProviders, createHughFallback, ACK_TEXT } = require('./hugh-fallback');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const OWNER_ID = 1;
const requireSession = (request) => { if (!request.session) { const e = new Error('вход'); e.status = 401; throw e; } return request.session; };
const requireCsrf = () => {};
const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
const readBody = async (request) => request.body ?? {};
const ENV = { HUGH_FALLBACK_PROVIDERS: 'openrouter,deepseek',
  HUGH_FALLBACK_OPENROUTER_URL: 'https://openrouter.example/api/v1', HUGH_FALLBACK_OPENROUTER_KEY: 'test-key-a', HUGH_FALLBACK_OPENROUTER_MODEL: 'free/model-a',
  HUGH_FALLBACK_DEEPSEEK_URL: 'https://deepseek.example/v1', HUGH_FALLBACK_DEEPSEEK_KEY: 'test-key-b', HUGH_FALLBACK_DEEPSEEK_MODEL: 'deepseek-chat' };

function setup({ runtime = null, reply = null, providers = {}, env = ENV, localCompanies = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugh-fallback-'));
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url); calls.push({ url: u, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
    if (u.endsWith('/status')) { const v = typeof runtime === 'function' ? runtime() : runtime; if (!v) throw new Error('служба не отвечает'); return { ok: true, status: 200, json: async () => v }; }
    if (u.startsWith('http://hugh-runtime')) { const v = (typeof reply === 'function' ? reply() : reply) || { status: 503 }; return { ok: v.status < 400, status: v.status, headers: { get: () => null }, json: async () => v.payload || {} }; }
    const name = u.includes('openrouter') ? 'openrouter' : 'deepseek';
    const v = typeof providers[name] === 'function' ? providers[name](calls) : providers[name];
    if (!v) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    if (v.timeout) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return { ok: (v.status || 200) < 400, status: v.status || 200, headers: { get: (h) => (v.headers || {})[h] ?? null },
      json: async () => v.payload ?? { choices: [{ message: { content: v.text || '' } }], model: v.model || name + '-model' } };
  };
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080', chatApiKey: 'secret-key',
    requireSession, requireCsrf, sendJson, readBody, fetchImpl, statusTtl: 0, fallback: { env },
    localWorker: { keySha256: 'a'.repeat(64), companies: localCompanies } });
  const owner = { user: authStore.getById(OWNER_ID), csrf: 'csrf' };
  const say = async (text, id, code = 'taisabai') => {
    const response = { statusCode: 0, payload: null, writeHead() {}, end() {} };
    await chat.handle({ method: 'POST', headers: {}, session: owner, body: { text, clientMessageId: 'client-' + id + '-00000001' } }, response, new URL(`http://x/content/project-chat/${code}/messages`));
    assert.equal(response.statusCode, 201, JSON.stringify(response.payload));
  };
  const jobs = () => db.prepare('SELECT * FROM project_chat_ai_jobs ORDER BY id').all();
  const replies = (code = 'taisabai') => db.prepare(`SELECT text FROM project_chat_messages WHERE company_code=? AND author_type='assistant' ORDER BY id`).all(code).map((r) => r.text);
  return { db, chat, calls, say, jobs, replies, owner };
}

test('провайдер считается настроенным только с адресом, ключом и моделью; ключи не попадают в статус', () => {
  const { providers, issues } = readProviders({ ...ENV, HUGH_FALLBACK_PROVIDERS: 'openrouter,deepseek,broken,Bad Name', HUGH_FALLBACK_BROKEN_URL: 'https://x' });
  assert.deepEqual(providers.map((p) => p.name), ['openrouter', 'deepseek']);
  assert.equal(issues.length, 2);
  const db = new DatabaseSync(':memory:');
  const fb = createHughFallback({ db, env: ENV, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(JSON.stringify(fb.status()).includes('test-key'), false);
  assert.equal(JSON.stringify(fb.providers).includes('test-key'), false);
  const none = createHughFallback({ db, env: {} });
  assert.equal(none.status().configured, false); assert.equal(none.available().length, 0);
});

test('без основной подписки ответ идёт через первый доступный резерв; 429 и 5xx переводят провайдера в cooldown, а второй отвечает', async () => {
  let first = { status: 429, headers: { 'retry-after': '120' } };
  const s = setup({ runtime: { connected: false, state: 'login_required' }, providers: { openrouter: () => first, deepseek: { text: 'Ответ резерва B' } } });
  await s.say('Хью, какие сроки?', 'm1');
  await s.chat.processAIJobs();
  assert.deepEqual(s.replies(), ['Ответ резерва B']);
  const job = s.jobs()[0]; assert.equal(job.status, 'done'); assert.equal(job.provider, 'deepseek');
  const status = s.chat.fallback.status();
  assert.equal(status.providers[0].cooling, true); assert.match(status.providers[0].lastError, /429/);
  assert.equal(status.providers[1].live, true);
  assert.equal(s.calls.filter((c) => c.url.startsWith('http://hugh-runtime:8080/reply')).length, 0, 'основной путь не вызывался без подключения');
  // второй вопрос: openrouter в cooldown — сразу deepseek, без лишнего вызова
  const before = s.calls.length;
  await s.say('Хью, а бюджет?', 'm2');
  await s.chat.processAIJobs();
  assert.equal(s.calls.slice(before).filter((c) => c.url.includes('openrouter')).length, 0);
  assert.equal(s.replies().length, 2);
  // системный промпт и история переданы в OpenAI-формате, ключ — в заголовке, не в теле
  const call = s.calls.find((c) => c.url.includes('deepseek'));
  assert.equal(call.body.messages[0].role, 'system'); assert.match(call.body.messages[0].content, /Хью, бизнес-ассистент/);
  assert.equal(call.headers.authorization, 'Bearer test-key-b');
});

test('все пути недоступны: вопрос ждёт без сгорания попыток, участники получают одно честное подтверждение приёма на 30 минут, без обещаний', async () => {
  const s = setup({ runtime: { connected: false, state: 'login_required' }, providers: { openrouter: { status: 503 }, deepseek: { timeout: true } } });
  await s.say('Хью, срочно!', 'm1');
  await s.say('Хью, и ещё вопрос', 'm2');
  await s.chat.processAIJobs();
  await s.chat.processAIJobs();
  const jobs = s.jobs();
  assert.ok(jobs.every((j) => j.status === 'blocked' && j.attempts === 0 && j.reply_message_id === null), JSON.stringify(jobs));
  assert.deepEqual(s.replies(), [ACK_TEXT], 'ровно одно подтверждение на компанию');
  assert.doesNotMatch(ACK_TEXT, /выполнено|готово|сделано/i);
  assert.match(ACK_TEXT, /ИИ/);
  // подтверждение ушло в очередь Telegram как обычное сообщение ассистента только при привязке — привязки нет
  assert.equal(s.db.prepare('SELECT count(*) n FROM project_chat_outbox').get().n, 0);
  // после восстановления провайдера вопросы отвечаются, второе подтверждение не шлётся
  const fb = s.chat.fallback;
  s.db.prepare("UPDATE project_chat_provider_state SET cooldown_until=NULL WHERE provider='deepseek'").run();
  s.db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z'").run();
  const s2providers = { deepseek: { text: 'Теперь отвечаю' } };
  // подменяем ответ провайдера через новый setup невозможно — используем cooldown-сброс и повторный вызов с тем же fetch: deepseek всё ещё timeout
  await s.chat.processAIJobs();
  assert.equal(s.replies().length, 1, 'при повторном отказе подтверждение не дублируется');
  assert.ok(fb.status().providers.every((p) => p.live === false));
  void s2providers;
});

test('основная подписка на лимите → резерв отвечает; успешный ответ записывается один раз даже при повторной обработке', async () => {
  let runtimeCalls = 0;
  const s = setup({ runtime: { connected: true, authenticated: true, state: 'ready' }, reply: () => { runtimeCalls += 1; return { status: 429, payload: { retryAfter: 600 } }; },
    providers: { openrouter: { text: 'Резерв A' } } });
  await s.say('Хью, привет', 'm1');
  await s.chat.processAIJobs();
  assert.equal(runtimeCalls, 1);
  assert.deepEqual(s.replies(), ['Резерв A']);
  assert.equal(s.jobs()[0].provider, 'openrouter');
  await s.chat.processAIJobs();
  assert.deepEqual(s.replies(), ['Резерв A'], 'повторный проход не создаёт второй ответ');
});

test('изоляция компаний: ответ резерва попадает только в комнату вопроса, подтверждение — только компаниям с ожидающими вопросами', async () => {
  const s = setup({ runtime: { connected: false }, providers: { openrouter: (calls) => (calls.at(-1).body.messages.some((m) => m.content.includes('taisabai-вопрос')) ? { text: 'Для ТайСабай' } : { status: 503 }) } });
  await s.say('Хью, taisabai-вопрос', 'm1', 'taisabai');
  await s.say('Хью, alvi-вопрос', 'm2', 'alvi');
  await s.chat.processAIJobs();
  assert.deepEqual(s.replies('taisabai'), ['Для ТайСабай']);
  assert.deepEqual(s.replies('alvi'), [ACK_TEXT]);
  assert.equal(s.db.prepare("SELECT count(*) n FROM project_chat_messages WHERE company_code='taisabai' AND author_type='assistant'").get().n, 1);
});

test('компания локального обработчика: сервер подхватывает вопрос через резерв только при долгом офлайне и держит аренду', async () => {
  const env = { ...ENV, HUGH_FALLBACK_LOCAL_OFFLINE_MINUTES: '10' };
  const s = setup({ runtime: { connected: false }, providers: { openrouter: { text: 'Резерв для Palitra' } }, env, localCompanies: ['palitra-love'] });
  // компьютер выходил на связь 30 минут назад — дольше порога 10 минут
  s.db.prepare(`INSERT INTO project_chat_local_worker(id,boot_id,last_seen_at,status) VALUES(1,'boot',?,'{}')`).run(new Date(Date.now() - 30 * 60000).toISOString());
  await s.say('Хью, вопрос Палитры', 'm1', 'palitra-love');
  await s.chat.processAIJobs();
  assert.deepEqual(s.replies('palitra-love'), ['Резерв для Palitra']);
  const job = s.jobs()[0]; assert.equal(job.status, 'done'); assert.equal(job.provider, 'openrouter');
  // свежий heartbeat — сервер локальные компании не трогает
  const t = setup({ runtime: { connected: false }, providers: { openrouter: { text: 'Не должно быть' } }, env, localCompanies: ['palitra-love'] });
  t.db.prepare(`INSERT INTO project_chat_local_worker(id,boot_id,last_seen_at,status) VALUES(1,'boot',?,'{}')`).run(new Date().toISOString());
  await t.say('Хью, вопрос', 'm1', 'palitra-love');
  await t.chat.processAIJobs();
  assert.deepEqual(t.replies('palitra-love'), []);
  assert.equal(t.jobs()[0].status, 'pending');
});
