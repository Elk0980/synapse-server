'use strict';
/* Защищённый ввод ключей провайдеров Хью: write-only секрет, fail-closed без мастер-ключа,
   запрет произвольного адреса и переадресации, учёт проверки в общем бюджете, подтверждение
   контракта по структуре ответа, привязка результата к версии настройки, включение только
   после свежего успеха.
   Живых обращений и платежей здесь нет: сеть подменена, ключи выдуманные. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createHughProviders, HUGH_PROVIDER_CATALOG} = require('./hugh-providers');
const {createHughFallback} = require('./hugh-fallback');

const MASTER = 'x'.repeat(48);
const KEY = 'sk-test-0123456789abcdef';
const BASE = 'https://api.deepseek.com/v1';
const OWNER = {userName: 'Владелец'};
const settings = (patch = {}) => ({revision: 0, baseUrl: BASE, modelId: 'vendor/model-1',
  apiKey: KEY, enabled: false, ...patch});
const chat = (patch = {}) => ({model: 'vendor/model-1', usage: {prompt_tokens: 5, completion_tokens: 1},
  choices: [{message: {role: 'assistant', content: ''}}], ...patch});
const json = (status, payload, extra = {}) => ({ok: status < 400, status, redirected: false,
  headers: {get: () => null}, json: async () => payload, ...extra});

function fixture({env = {}} = {}) {
  const db = new DatabaseSync(':memory:');
  let time = Date.parse('2026-09-19T10:00:00Z');
  const store = createHughProviders({db, env: {HUGH_PROVIDER_MASTER_KEY: MASTER, ...env}, now: () => time});
  const calls = [];
  const fetcher = (responder) => async (url, options) => {
    calls.push({url, options, auth: options.headers.authorization, redirect: options.redirect});
    return responder(calls.length);
  };
  return {db, store, calls, fetcher, advance: (ms) => { time += ms; }};
}
// Полный путь до рабочего состояния: сохранить → проверить → включить.
async function activate(f, responder = () => json(200, chat())) {
  const saved = f.store.save('deepseek', settings(), OWNER);
  const checked = await f.store.check('deepseek', {fetchImpl: f.fetcher(responder)});
  assert.equal(checked.checkState, 'ok', checked.checkMessage);
  return f.store.save('deepseek', settings({revision: checked.revision, apiKey: undefined, enabled: true}), OWNER);
}

test('без мастер-ключа хранилище закрыто и ключ сохранить нельзя', (t) => {
  const f = fixture({env: {HUGH_PROVIDER_MASTER_KEY: ''}});
  t.after(() => f.db.close());
  assert.equal(f.store.status().storeAvailable, false);
  assert.throws(() => f.store.save('deepseek', settings(), OWNER),
    (error) => error.status === 503 && error.details.code === 'SECRET_STORE_LOCKED');
  assert.deepEqual(f.store.runtimeProviders(), []);
  const weak = fixture({env: {HUGH_PROVIDER_MASTER_KEY: 'short'}});
  t.after(() => weak.db.close());
  assert.match(weak.store.status().lockedReason, /короче/);
});

test('ключ не возвращается ни в статусе, ни в ответе сохранения, ни в базе открытым текстом', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const saved = f.store.save('deepseek', settings(), OWNER);
  assert.equal(saved.keyConfigured, true);
  assert.equal(saved.apiKey, undefined);
  const dump = JSON.stringify({saved, status: f.store.status(), view: f.store.view('deepseek')});
  assert.doesNotMatch(dump, new RegExp(KEY));
  const stored = f.db.prepare('SELECT encrypted_key FROM hugh_provider_settings WHERE name=?').get('deepseek');
  assert.doesNotMatch(stored.encrypted_key, new RegExp(KEY));
  assert.equal(JSON.parse(stored.encrypted_key).v, 1);
  const other = createHughProviders({db: f.db, env: {HUGH_PROVIDER_MASTER_KEY: 'y'.repeat(48)}});
  assert.deepEqual(other.runtimeProviders(), [], 'другой мастер-ключ ключи не расшифровывает');
});

test('произвольный адрес не принимается: только официальные хосты, только https', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  for (const baseUrl of ['http://api.deepseek.com/v1', 'https://169.254.169.254/latest',
    'https://127.0.0.1/v1', 'https://api.deepseek.com.evil.test/v1', 'https://evil.test/v1',
    'https://user:pass@api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1',
    'https://api.deepseek.com/v1?x=1', 'https://api.mistral.ai/v1', 'не адрес']) {
    assert.throws(() => f.store.save('deepseek', settings({baseUrl}), OWNER),
      (error) => error.status === 400, baseUrl);
  }
  const extended = fixture({env: {HUGH_PROVIDER_ALLOWED_HOSTS: 'api.internal-mirror.test'}});
  t.after(() => extended.db.close());
  assert.equal(extended.store.save('deepseek', settings({baseUrl: 'https://api.internal-mirror.test/v1'}), OWNER).baseUrl,
    'https://api.internal-mirror.test/v1');
});

test('включить можно только после успешной проверки этой же версии настройки', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const saved = f.store.save('deepseek', settings(), OWNER);
  assert.equal(saved.enabled, false);
  assert.equal(saved.checkCurrent, false);
  // Без проверки включение отклоняется.
  assert.throws(() => f.store.save('deepseek', settings({revision: saved.revision, apiKey: undefined, enabled: true}), OWNER),
    (error) => error.status === 400 && error.details.code === 'CHECK_REQUIRED');
  const checked = await f.store.check('deepseek', {fetchImpl: f.fetcher(() => json(200, chat()))});
  assert.equal(checked.checkCurrent, true);
  const enabled = f.store.save('deepseek', settings({revision: checked.revision, apiKey: undefined, enabled: true}), OWNER);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.checkCurrent, true, 'переключение enabled саму проверку не ломает');
  assert.equal(f.store.runtimeProviders().length, 1);
  // Выключить и включить обратно тоже можно без повторной проверки.
  const off = f.store.save('deepseek', settings({revision: enabled.revision, apiKey: undefined, enabled: false}), OWNER);
  const on = f.store.save('deepseek', settings({revision: off.revision, apiKey: undefined, enabled: true}), OWNER);
  assert.equal(on.checkCurrent, true);
  assert.equal(f.store.runtimeProviders().length, 1);
});

test('смена ключа, модели или адреса обесценивает проверку и выключает провайдера', async (t) => {
  for (const patch of [{apiKey: 'sk-other-9876543210'}, {modelId: 'vendor/model-2'},
    {baseUrl: 'https://api.deepseek.com/v2'}]) {
    const f = fixture();
    t.after(() => f.db.close());
    const active = await activate(f);
    assert.equal(f.store.runtimeProviders().length, 1);
    // Материальная правка вместе с включением запрещена: проверка к ней не относится.
    assert.throws(() => f.store.save('deepseek',
      settings({revision: active.revision, apiKey: undefined, enabled: true, ...patch}), OWNER),
    (error) => error.details.code === 'CHECK_REQUIRED', JSON.stringify(patch));
    const changed = f.store.save('deepseek',
      settings({revision: active.revision, apiKey: undefined, enabled: false, ...patch}), OWNER);
    assert.equal(changed.checkCurrent, false, JSON.stringify(patch));
    assert.equal(changed.checkStale, true);
    assert.deepEqual(f.store.runtimeProviders(), [], 'без свежей проверки в рантайм ничего не уходит');
  }
});

test('в рантайм не попадает включённый провайдер без актуальной успешной проверки', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  await activate(f);
  assert.equal(f.store.runtimeProviders().length, 1);
  // Подделка состояния в обход маршрута: включено, но проверка относится к другой версии.
  f.db.prepare('UPDATE hugh_provider_settings SET config_revision=config_revision+1 WHERE name=?').run('deepseek');
  assert.deepEqual(f.store.runtimeProviders(), [], 'устаревшая проверка провайдера не оправдывает');
  f.db.prepare("UPDATE hugh_provider_settings SET check_state='failed',checked_revision=config_revision WHERE name=?").run('deepseek');
  assert.deepEqual(f.store.runtimeProviders(), [], 'неуспешная проверка тоже не оправдывает');
});

test('проверка идёт через общий учёт бюджета и останавливается до сети', async (t) => {
  // Денежная граница задана, цена провайдера неизвестна — обращения быть не должно.
  const unpriced = fixture({env: {HUGH_FALLBACK_BUDGET_USD: '20'}});
  t.after(() => unpriced.db.close());
  unpriced.store.save('deepseek', settings(), OWNER);
  const blocked = await unpriced.store.check('deepseek', {fetchImpl: unpriced.fetcher(() => json(200, chat()))});
  assert.equal(blocked.checkState, 'blocked');
  assert.match(blocked.checkMessage, /[Цц]ена провайдера/);
  assert.equal(unpriced.calls.length, 0, 'ни одного платного обращения');

  // Граница числа обращений исчерпана — проверка тоже останавливается до сети.
  const spent = fixture({env: {HUGH_FALLBACK_BUDGET_MAX_REQUESTS: '1'}});
  t.after(() => spent.db.close());
  spent.store.save('deepseek', settings(), OWNER);
  const first = await spent.store.check('deepseek', {fetchImpl: spent.fetcher(() => json(200, chat()))});
  assert.equal(first.checkState, 'ok');
  assert.equal(spent.calls.length, 1);
  const second = await spent.store.check('deepseek', {fetchImpl: spent.fetcher(() => json(200, chat()))});
  assert.equal(second.checkState, 'blocked');
  assert.match(second.checkMessage, /граница числа обращений/i);
  assert.equal(spent.calls.length, 1, 'после исчерпания бюджета сети не было');
});

test('подтверждением считается структура ответа, а не факт HTTP 200', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.save('deepseek', settings(), OWNER);
  for (const payload of [{}, {choices: []}, {choices: [{}]}, {choices: [{message: {}}]},
    {choices: [{message: {role: 'assistant'}}]}, {choices: [{message: {role: '', content: 'x'}}]},
    {choices: 'ok'}, null]) {
    const result = await f.store.check('deepseek', {fetchImpl: f.fetcher(() => json(200, payload))});
    assert.equal(result.checkState, 'failed', JSON.stringify(payload));
    assert.match(result.checkMessage, /контракт не подтверждён/);
  }
  // Пустой текст при max_tokens=1 допустим и подтверждению не мешает.
  const empty = await f.store.check('deepseek', {fetchImpl: f.fetcher(() => json(200, chat()))});
  assert.equal(empty.checkState, 'ok');
  assert.equal(f.calls.at(-1).options.body.includes('"max_tokens":1'), true);
  // Массив частей содержимого — тоже допустимый контракт.
  const parts = await f.store.check('deepseek', {fetchImpl: f.fetcher(() =>
    json(200, chat({choices: [{message: {role: 'assistant', content: [{type: 'text', text: 'pong'}]}}]})))});
  assert.equal(parts.checkState, 'ok');
});

test('переадресация запрещена и не считается успехом', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.save('deepseek', settings(), OWNER);
  const viaThrow = await f.store.check('deepseek', {fetchImpl: f.fetcher(() => {
    throw Object.assign(new Error('unexpected redirect'), {name: 'TypeError'});
  })});
  assert.equal(viaThrow.checkState, 'failed');
  assert.match(viaThrow.checkMessage, /перенаправляет/);
  const viaFlag = await f.store.check('deepseek', {fetchImpl: f.fetcher(() =>
    json(200, chat(), {redirected: true}))});
  assert.equal(viaFlag.checkState, 'failed');
  assert.match(viaFlag.checkMessage, /перенаправляет/);
  const viaStatus = await f.store.check('deepseek', {fetchImpl: f.fetcher(() => json(302, {}))});
  assert.equal(viaStatus.checkState, 'failed');
  // Сам запрос уходит с запретом переадресации.
  assert.ok(f.calls.every((call) => call.redirect === 'error'));
});

test('результат проверки не подтверждает настройку, изменённую во время запроса', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const saved = f.store.save('deepseek', settings(), OWNER);
  const result = await f.store.check('deepseek', {fetchImpl: async () => {
    // Параллельное сохранение меняет модель, пока запрос в пути.
    f.store.save('deepseek', settings({revision: saved.revision, apiKey: undefined, modelId: 'vendor/model-9'}), OWNER);
    return json(200, chat());
  }});
  assert.equal(result.modelId, 'vendor/model-9');
  assert.equal(result.checkCurrent, false, 'чужая новая настройка не подтверждена');
  assert.equal(result.checkStale, true);
  assert.match(result.checkMessage, /настройка изменилась во время проверки/);
  assert.deepEqual(f.store.runtimeProviders(), []);
  assert.throws(() => f.store.save('deepseek', settings({revision: result.revision, apiKey: undefined, enabled: true}), OWNER),
    (error) => error.details.code === 'CHECK_REQUIRED');
});

test('ключ не возвращается, даже если провайдер вернул его в model или тексте ошибки', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.save('deepseek', settings(), OWNER);
  const echoed = await f.store.check('deepseek', {fetchImpl: f.fetcher(() =>
    json(200, chat({model: `эхо ${KEY} конец`})))});
  assert.equal(echoed.checkState, 'ok');
  assert.doesNotMatch(echoed.checkMessage, new RegExp(KEY));
  assert.match(echoed.checkMessage, /\[ключ скрыт\]/);
  assert.doesNotMatch(JSON.stringify(f.store.status()), new RegExp(KEY));
  // Тот же запрет для сообщения об отклонённом адресе.
  const moved = fixture({env: {HUGH_PROVIDER_ALLOWED_HOSTS: 'api.internal-mirror.test'}});
  t.after(() => moved.db.close());
  moved.store.save('deepseek', settings({baseUrl: 'https://api.internal-mirror.test/v1'}), OWNER);
  const narrowed = createHughProviders({db: moved.db, env: {HUGH_PROVIDER_MASTER_KEY: MASTER}});
  const denied = await narrowed.check('deepseek', {fetchImpl: async () => { throw new Error('не должно вызываться'); }});
  assert.equal(denied.checkState, 'failed');
  assert.match(denied.checkMessage, /не входит в список официальных/);
});

test('провайдер без реализованного контракта не принимается и не проверяется', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const anthropic = f.store.status().providers.find((item) => item.name === 'anthropic');
  assert.equal(anthropic.contractSupported, false);
  assert.match(anthropic.unsupportedReason, /Адаптер не написан/);
  assert.throws(() => f.store.save('anthropic', {revision: 0, baseUrl: 'https://api.anthropic.com/v1',
    modelId: 'm', apiKey: KEY}, OWNER), (error) => error.details.code === 'CONTRACT_NOT_SUPPORTED');
  await assert.rejects(f.store.check('anthropic', {}), (error) => error.details.code === 'CONTRACT_NOT_SUPPORTED');
  assert.ok(f.store.status().providers.filter((item) => item.contractSupported).length >= 6);
});

test('подтверждённый провайдер попадает в существующий рантайм ответов', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  await activate(f);
  const runtime = f.store.runtimeProviders();
  assert.deepEqual([runtime[0].name, runtime[0].url, runtime[0].model], ['deepseek', BASE, 'vendor/model-1']);
  const calls = [];
  const fallback = createHughFallback({db: f.db, env: {}, providerStore: f.store,
    fetchImpl: async (url, options) => {
      calls.push({url, redirect: options.redirect});
      return json(200, chat({choices: [{message: {role: 'assistant', content: 'Ответ провайдера'}}]}));
    }});
  assert.equal(fallback.providers.length, 1);
  const answer = await fallback.reply(JSON.stringify({system: 's', messages: [{role: 'user', content: 'q'}]}));
  assert.equal(answer.text, 'Ответ провайдера');
  assert.equal(calls[0].url, `${BASE}/chat/completions`);
  assert.equal(calls[0].redirect, 'error', 'рантайм тоже запрещает переадресацию');
  assert.equal(JSON.stringify(fallback.status()).includes(KEY), false);
});

test('закрытое хранилище видно в статусе рантайма и не даёт провайдеров', (t) => {
  const f = fixture({env: {HUGH_PROVIDER_MASTER_KEY: ''}});
  t.after(() => f.db.close());
  const fallback = createHughFallback({db: f.db, env: {}, providerStore: f.store});
  assert.equal(fallback.providers.length, 0);
  assert.ok(fallback.status().issues.some((issue) => /HUGH_PROVIDER_MASTER_KEY/i.test(issue)));
});

test('каталог кандидатов перечислен, неизвестные провайдеры не принимаются', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const names = HUGH_PROVIDER_CATALOG.map((item) => item.name);
  for (const expected of ['zai', 'qwen', 'deepseek', 'gemini', 'mistral', 'openai', 'anthropic']) {
    assert.ok(names.includes(expected), expected);
  }
  assert.throws(() => f.store.save('unknown-vendor', settings(), OWNER), (error) => error.status === 404);
  const status = f.store.status();
  assert.equal(status.apiStyle, 'openai-chat-completions');
  assert.match(status.notice, /Совместимость подтверждается только успешной проверкой/);
});

test('лишние поля и подозрительное значение ключа отвергаются', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  assert.throws(() => f.store.save('deepseek', {...settings(), unexpected: 'x'}, OWNER),
    (error) => /Неизвестные поля/.test(error.message));
  for (const apiKey of ['short', 'секретный token', 'a'.repeat(3000), 'key with space']) {
    assert.throws(() => f.store.save('deepseek', settings({apiKey}), OWNER), (error) => error.status === 400, apiKey);
  }
  assert.throws(() => f.store.save('deepseek', settings({modelId: ''}), OWNER),
    (error) => /идентификатор модели/.test(error.message));
  assert.throws(() => f.store.save('deepseek', settings(), OWNER) && f.store.save('deepseek', settings(), OWNER),
    (error) => error.details.code === 'REVISION_CONFLICT');
});
