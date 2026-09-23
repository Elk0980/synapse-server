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
const { createHughProviders } = require('./hugh-providers');

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

test('настройка из кабинета вступает в силу без перезапуска рантайма ответов', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let ready = [];
  const calls = [];
  const providerStore = { available: true, runtimeProviders: () => ready };
  const fb = createHughFallback({ db, env: {}, providerStore,
    fetchImpl: async (url, options) => {
      calls.push({ url, model: JSON.parse(options.body).model });
      return { ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'План построен' } }] }) };
    } });
  assert.equal(fb.status().configured, false);
  assert.equal(fb.available().length, 0);

  ready = [{ name: 'deepseek', url: 'https://example.test/v1', secret: 'test-key',
    model: 'model-one', timeoutMs: 10000 }];
  assert.equal(fb.status().configured, true);
  assert.equal(fb.available().length, 1);
  assert.equal(fb.leaseMs(), 40000);
  assert.equal((await fb.reply(JSON.stringify({ system: 's', messages: [] }))).text, 'План построен');
  assert.deepEqual(calls[0], { url: 'https://example.test/v1/chat/completions', model: 'model-one' });

  ready = [{ ...ready[0], model: 'model-two', timeoutMs: 20000 }];
  await fb.reply(JSON.stringify({ system: 's', messages: [] }));
  assert.equal(calls[1].model, 'model-two');
  assert.equal(fb.leaseMs(), 50000);
  ready = [];
  assert.equal(fb.status().configured, false);
  assert.equal(fb.available().length, 0);
  assert.equal(JSON.stringify(fb.status()).includes('test-key'), false);
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

test('основной путь падает (500/таймаут) и все резервы отказали: вопрос остаётся устойчиво в очереди, попытки не сгорают при повторных проходах; после восстановления отвечается один раз',async()=>{
  let providerState={openrouter:{status:503},deepseek:{timeout:true}};
  const s=setup({runtime:{connected:true,authenticated:true,state:'ready'},reply:()=>({status:500}),
    providers:{openrouter:()=>providerState.openrouter,deepseek:()=>providerState.deepseek}});
  await s.say('Хью, срочный вопрос','m1');
  for(let i=0;i<5;i++){s.db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z'").run();s.db.prepare('UPDATE project_chat_provider_state SET cooldown_until=NULL').run();await s.chat.processAIJobs();}
  const job=s.jobs()[0];
  assert.equal(job.status,'blocked',job.error);assert.equal(job.attempts,0,'попытки не сгорели');assert.equal(job.reply_message_id,null);assert.match(job.error,/ждёт в очереди/);
  assert.equal(s.replies().filter(t=>t===ACK_TEXT).length,1,'одно подтверждение приёма');
  providerState={openrouter:{text:'Наконец ответ'},deepseek:{timeout:true}};
  s.db.prepare("UPDATE project_chat_ai_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z'").run();s.db.prepare('UPDATE project_chat_provider_state SET cooldown_until=NULL').run();
  await s.chat.processAIJobs();await s.chat.processAIJobs();
  assert.deepEqual(s.replies().filter(t=>t!==ACK_TEXT),['Наконец ответ']);assert.equal(s.jobs()[0].status,'done');
});

test('подхват локальной компании: серверная аренда покрывает таймауты провайдеров и продлевается; зависшее после сбоя running восстанавливается без второго ответа',async()=>{
  const env={...ENV,HUGH_FALLBACK_LOCAL_OFFLINE_MINUTES:'10',HUGH_FALLBACK_OPENROUTER_TIMEOUT_MS:'90000',HUGH_FALLBACK_DEEPSEEK_TIMEOUT_MS:'90000'};
  const leases=[];
  const s=setup({runtime:{connected:false},providers:{openrouter:(calls)=>{leases.push(s.db.prepare("SELECT lease_expires_at FROM project_chat_ai_jobs WHERE id=1").get().lease_expires_at);return {status:503};},deepseek:{text:'Резерв B'}},env,localCompanies:['palitra-love']});
  assert.equal(s.chat.fallback.leaseMs(),90000*2+30000,'аренда = сумма таймаутов + запас');
  s.db.prepare(`INSERT INTO project_chat_local_worker(id,boot_id,last_seen_at,status) VALUES(1,'boot',?,'{}')`).run(new Date(Date.now()-30*60000).toISOString());
  await s.say('Хью, вопрос','m1','palitra-love');
  await s.chat.processAIJobs();
  assert.deepEqual(s.replies('palitra-love'),['Резерв B']);
  assert.ok(leases.length>=1&&Date.parse(leases[0])-Date.now()>=90000*2,'аренда при первом обращении длиннее суммы таймаутов');
  // сбой сервера посреди подхвата: running, boot_id=server, аренда истекла, ответа нет → берётся заново, без дубля
  await s.say('Хью, второй вопрос','m2','palitra-love');
  const second=s.jobs()[1];
  s.db.prepare("UPDATE project_chat_ai_jobs SET status='running',boot_id='server',lease_token='server-fallback',lease_expires_at=?,attempts=1 WHERE id=?").run(new Date(Date.now()-1000).toISOString(),second.id);
  await s.chat.processAIJobs();
  assert.deepEqual(s.replies('palitra-love'),['Резерв B','Резерв B']);assert.equal(s.jobs()[1].status,'done');
  // пока серверная аренда действует, повторный проход задание не трогает и не дублирует
  await s.say('Хью, третий','m3','palitra-love');const third=s.jobs()[2];
  s.db.prepare("UPDATE project_chat_ai_jobs SET status='running',boot_id='server',lease_token='server-fallback',lease_expires_at=? WHERE id=?").run(new Date(Date.now()+60000).toISOString(),third.id);
  await s.chat.processAIJobs();assert.equal(s.jobs()[2].status,'running');assert.equal(s.replies('palitra-love').length,2);
  // перезапуск сервера возвращает такие задания в очередь; уже отвеченное закрывается
  s.db.prepare("UPDATE project_chat_ai_jobs SET reply_message_id=(SELECT id FROM project_chat_messages WHERE author_type='assistant' LIMIT 1) WHERE id=?").run(second.id);
  s.db.prepare("UPDATE project_chat_ai_jobs SET status='running',boot_id='server' WHERE id=?").run(second.id);
  s.chat.startWorker();s.chat.stopWorker();
  assert.equal(s.jobs()[2].status,'pending');assert.equal(s.jobs()[2].lease_token,null);assert.equal(s.jobs()[1].status,'done');
});

/* Цена провайдера, введённая в кабинете, и учёт расхода в ответах.
   Проверка соединения уже шла через бюджет с ценами из хранилища, а живой ответ — нет:
   при денежной границе сохранённый провайдер отвергался как «цена не задана».
   Берутся настоящие createHughProviders и createHughBudget, подменена только сеть;
   ключи выдуманные, живых обращений и платежей нет. */
const MASTER_KEY = 'm'.repeat(48);
const STORE_KEY = 'sk-test-0123456789abcdef';
const STORE_BASE = 'https://api.deepseek.com/v1';
const STORE_MODEL = 'vendor/model-1';
const OWNER = { userName: 'Владелец' };
const MICRO = 1000000;
const PRICES = { pricePromptUsdPer1k: 0.0003, priceCompletionUsdPer1k: 0.0012 };
// Цена та же в переменных окружения: 0.0003 за 1000 токенов запроса и 0.0012 за 1000 ответа.
const ENV_PRICED = { HUGH_FALLBACK_PROVIDERS: 'deepseek', HUGH_FALLBACK_DEEPSEEK_URL: 'https://deepseek.example/v1',
  HUGH_FALLBACK_DEEPSEEK_KEY: 'test-key-b', HUGH_FALLBACK_DEEPSEEK_MODEL: 'deepseek-chat',
  HUGH_FALLBACK_DEEPSEEK_USD_PER_1K_PROMPT: '0.0003', HUGH_FALLBACK_DEEPSEEK_USD_PER_1K_COMPLETION: '0.0012' };
const providerAnswer = (usage, text = 'Ответ провайдера') => ({ ok: true, status: 200, redirected: false,
  headers: { get: () => null },
  json: async () => ({ model: STORE_MODEL, usage, choices: [{ message: { role: 'assistant', content: text } }] }) });
const ASK = JSON.stringify({ system: 's', messages: [{ role: 'user', content: 'q' }] });
// Путь кабинета целиком: сохранить → проверить соединение → включить.
async function savedProvider({ env = {}, prices = PRICES, budgetUsd = null } = {}) {
  const db = new DatabaseSync(':memory:');
  const full = { HUGH_PROVIDER_MASTER_KEY: MASTER_KEY, ...env };
  const store = createHughProviders({ db, env: full });
  store.save('deepseek', { revision: 0, baseUrl: STORE_BASE, modelId: STORE_MODEL, apiKey: STORE_KEY,
    enabled: false, budgetUsd, ...prices }, OWNER);
  const checked = await store.check('deepseek',
    { fetchImpl: async () => providerAnswer({ prompt_tokens: 5, completion_tokens: 1 }, '') });
  assert.equal(checked.checkState, 'ok', checked.checkMessage);
  store.save('deepseek', { revision: checked.revision, enabled: true }, OWNER);
  assert.equal(store.runtimeProviders().length, 1);
  return { db, store, env: full };
}
const spentMicro = (before, after) => Math.round((after.spentUsd - before.spentUsd) * MICRO);

test('сохранённая в кабинете цена доходит до бюджета: провайдер с личным лимитом отвечает и списывает точный usage', async (t) => {
  const f = await savedProvider({ budgetUsd: 5 });
  t.after(() => f.db.close());
  const calls = [];
  const fallback = createHughFallback({ db: f.db, env: f.env, providerStore: f.store,
    fetchImpl: async (url, options) => { calls.push({ url, model: JSON.parse(options.body).model });
      return providerAnswer({ prompt_tokens: 1000, completion_tokens: 500 }); } });
  assert.equal(fallback.status().providers[0].ownLimitUsd, 5);
  const before = fallback.budget.state();
  assert.equal(before.configured, false, 'работает личная граница без общей границы бюджета');
  const answer = await fallback.reply(ASK);
  assert.equal(answer.text, 'Ответ провайдера');
  assert.deepEqual(calls, [{ url: `${STORE_BASE}/chat/completions`, model: STORE_MODEL }]);
  const after = fallback.budget.state();
  // 1000 токенов запроса по 0.0003 и 500 токенов ответа по 0.0012 — ровно 900 микродолларов.
  assert.equal(spentMicro(before, after), 900);
  assert.equal(after.heldUsd, 0, 'бронь уточнена фактом, а не осталась верхней оценкой');
  assert.equal(after.unknownRequests, 0, 'цена и usage известны — расход не считается неизвестным');
  assert.equal(fallback.status().providers[0].spentUsd > 0, true);
});

test('новая цена из кабинета применяется к следующему ответу без пересоздания резерва', async (t) => {
  const f = await savedProvider({ budgetUsd: 5 });
  t.after(() => f.db.close());
  let calls = 0;
  const fallback = createHughFallback({ db: f.db, env: f.env, providerStore: f.store,
    fetchImpl: async () => { calls++; return providerAnswer({ prompt_tokens: 1000, completion_tokens: 500 }); } });
  const start = fallback.budget.state();
  await fallback.reply(ASK);
  const afterFirst = fallback.budget.state();
  assert.equal(spentMicro(start, afterFirst), 900);
  // Правка цены не трогает адрес, модель и ключ, поэтому проверка соединения остаётся действующей.
  const view = f.store.view('deepseek');
  f.store.save('deepseek', { revision: view.revision, pricePromptUsdPer1k: 0.001,
    priceCompletionUsdPer1k: 0.002 }, OWNER);
  assert.equal(f.store.view('deepseek').enabled, true);
  await fallback.reply(ASK);
  // 1000 × 0.001 + 500 × 0.002 = 2000 микродолларов по новой цене, а не по прежней.
  assert.equal(spentMicro(afterFirst, fallback.budget.state()), 2000);
  f.store.save('deepseek', { revision: f.store.view('deepseek').revision, priceCompletionUsdPer1k: 10 }, OWNER);
  await assert.rejects(fallback.reply(ASK),
    (error) => error.budgetStopped === true && /личный лимит/.test(error.message));
  assert.equal(calls, 2, 'новая цена применяется к брони до сети, а не только при списании');
});

test('удалённая или неполная цена кабинета блокирует сеть при личном лимите даже с одноимённой ценой env', async (t) => {
  for (const missing of [{ pricePromptUsdPer1k: null, priceCompletionUsdPer1k: null },
    { pricePromptUsdPer1k: null }, { priceCompletionUsdPer1k: null }]) {
    const f = await savedProvider({ env: ENV_PRICED, budgetUsd: 5 });
    t.after(() => f.db.close());
    let calls = 0;
    const fallback = createHughFallback({ db: f.db, env: f.env, providerStore: f.store,
      fetchImpl: async () => { calls++; throw new Error('сети быть не должно'); } });
    f.store.save('deepseek', { revision: f.store.view('deepseek').revision, ...missing }, OWNER);
    const before = fallback.budget.state();
    await assert.rejects(fallback.reply(ASK),
      (error) => /[Цц]ена провайдера/.test(error.message) && error.budgetStopped === true);
    assert.equal(calls, 0, 'ни одного платного обращения');
    assert.equal(spentMicro(before, fallback.budget.state()), 0);
    assert.equal(fallback.budget.state().heldRequests, 0, 'блокировка не создаёт бронь');
  }
});

test('цена провайдера из окружения действует без хранилища и с подключённым пустым хранилищем', async (t) => {
  for (const withStore of [false, true]) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const env = { ...ENV_PRICED, HUGH_PROVIDER_MASTER_KEY: MASTER_KEY, HUGH_FALLBACK_BUDGET_USD: '10' };
    const fromEnv = createHughFallback({ db, env, providerStore: withStore ? createHughProviders({ db, env }) : null,
      fetchImpl: async () => providerAnswer({ prompt_tokens: 1000, completion_tokens: 500 }) });
    const before = fromEnv.budget.state();
    assert.equal((await fromEnv.reply(ASK)).text, 'Ответ провайдера');
    assert.equal(spentMicro(before, fromEnv.budget.state()), 900);
  }
});

test('явный ноль в кабинете считается известной ценой и заменяет тариф одноимённого провайдера env', async (t) => {
  const f = await savedProvider({ env: ENV_PRICED, budgetUsd: 5,
    prices: { pricePromptUsdPer1k: 0, priceCompletionUsdPer1k: 0 } });
  t.after(() => f.db.close());
  const fallback = createHughFallback({ db: f.db, env: f.env, providerStore: f.store,
    fetchImpl: async () => providerAnswer({ prompt_tokens: 1000, completion_tokens: 500 }) });
  assert.equal((await fallback.reply(ASK)).text, 'Ответ провайдера');
  const state = fallback.budget.state();
  assert.equal(state.spentUsd, 0);
  assert.equal(state.requests, 2, 'проверка и ответ учитываются даже при нулевом тарифе');
  assert.equal(state.unknownRequests, 0);
  assert.equal(state.heldRequests, 0);
});
