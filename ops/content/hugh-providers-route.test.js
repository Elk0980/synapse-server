'use strict';
/* Маршруты защищённого ввода ключей на настоящем сервисе контента: только владелец,
   CSRF на запись, ключ не возвращается, произвольный адрес отклоняется.
   Живых обращений к провайдерам и платежей нет. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process'), {once} = require('node:events');
const {randomBytes} = require('node:crypto'), {DatabaseSync} = require('node:sqlite');
const {createAuthStore} = require('./auth-store'), {hashPassword} = require('./passwords');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const KEY = 'sk-route-test-0123456789';

test('ввод ключей провайдеров: владелец, CSRF, ключ не возвращается, адрес из списка',
  {timeout: 60000}, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hugh-providers-route-')), children = [];
    const contentDb = path.join(directory, 'content.sqlite');
    const password = 'Local-providers-route-password';
    t.after(async () => {
      for (const child of children.reverse()) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill(); await exited;
        }
      }
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(directory, {recursive: true, force: true});
    });
    const authDb = new DatabaseSync(contentDb);
    const auth = createAuthStore(authDb, `owner:owner:${hashPassword(password)}`), owner = auth.getByLogin('owner');
    auth.create(owner.id, {login: 'client', displayName: 'client', password, companies: ['avokado'],
      permissions: ['crm.view']}, hashPassword(password));
    authDb.close();

    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const master = randomBytes(32).toString('hex');
    let errors = '';
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')],
      {env: {...process.env, PORT: String(port), DATABASE_PATH: contentDb, AUTH_USERS: '', API_KEY: '',
        CRM_URL: '', CRM_API_KEY: '', SEED_DIR: directory, ASSETS_DIR: path.join(directory, 'assets'),
        SESSION_SECRET: randomBytes(32).toString('hex'), HUGH_PROVIDER_MASTER_KEY: master,
        HUGH_RUNNER_URL: '', CHAT_URL: '', CHAT_API_KEY: ''},
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    children.push(child);
    child.stderr.on('data', (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw Error('Service failed: ' + errors);
      try { const probe = await fetch(base + '/health', {signal: AbortSignal.timeout(500)}); await probe.text(); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }

    async function request(route, {method = 'GET', body, headers = {}} = {}) {
      const response = await fetch(base + route, {method,
        headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000)});
      const text = await response.text();
      return {status: response.status, text, body: text ? JSON.parse(text) : null};
    }
    const sessions = {};
    for (const login of ['owner', 'client']) {
      const signed = await fetch(`${base}/content/login`, {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify({login, password})});
      assert.equal(signed.status, 200, login);
      const cookie = signed.headers.get('set-cookie').split(';')[0];
      const profile = await request('/content/whoami', {headers: {cookie}});
      sessions[login] = {cookie, 'x-csrf-token': profile.body.csrfToken};
    }
    const as = (who, route, options = {}) => request(route, {...options, headers: {...sessions[who], ...options.headers}});

    // Без сессии и не владельцу раздел закрыт.
    assert.equal((await request('/content/hugh-providers')).status, 401);
    assert.equal((await as('client', '/content/hugh-providers')).status, 403);
    assert.equal((await as('client', '/content/hugh-providers/deepseek',
      {method: 'PUT', body: {revision: 0, baseUrl: 'https://api.deepseek.com/v1', modelId: 'm', apiKey: KEY}})).status, 403);

    const status = await as('owner', '/content/hugh-providers');
    assert.equal(status.status, 200);
    assert.equal(status.body.storeAvailable, true);
    assert.ok(status.body.providers.some((item) => item.name === 'deepseek'));
    assert.ok(status.body.providers.every((item) => item.keyConfigured === false));

    // Запись без действительного CSRF-токена не проходит.
    for (const csrf of ['', 'wrong-token']) {
      assert.equal((await as('owner', '/content/hugh-providers/deepseek',
        {method: 'PUT', headers: {'x-csrf-token': csrf},
          body: {revision: 0, baseUrl: 'https://api.deepseek.com/v1', modelId: 'm', apiKey: KEY}})).status, 403);
    }
    // Произвольный адрес отклоняется на маршруте.
    for (const baseUrl of ['https://evil.test/v1', 'http://api.deepseek.com/v1', 'https://127.0.0.1/v1']) {
      const denied = await as('owner', '/content/hugh-providers/deepseek',
        {method: 'PUT', body: {revision: 0, baseUrl, modelId: 'm', apiKey: KEY}});
      assert.equal(denied.status, 400, baseUrl);
    }

    const saved = await as('owner', '/content/hugh-providers/deepseek',
      {method: 'PUT', body: {revision: 0, baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'vendor/model-1', apiKey: KEY, pricePromptUsdPer1k: 0.5, budgetUsd: 20}});
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.keyConfigured, true);
    assert.equal(saved.body.enabled, false, 'сохранение ничего не включает');
    assert.equal(saved.body.checkState, 'not_checked', 'сохранение не равно проверке');
    assert.equal(saved.body.budgetUsd, 20);
    assert.doesNotMatch(saved.text, new RegExp(KEY), 'ключ не возвращается в ответе');

    const after = await as('owner', '/content/hugh-providers');
    assert.doesNotMatch(after.text, new RegExp(KEY), 'ключ не возвращается в статусе');
    assert.equal(after.body.providers.find((item) => item.name === 'deepseek').keyConfigured, true);

    // Устаревшая версия настройки не перезаписывает чужую правку.
    assert.equal((await as('owner', '/content/hugh-providers/deepseek',
      {method: 'PUT', body: {revision: 0, baseUrl: 'https://api.deepseek.com/v1', modelId: 'x'}})).status, 409);
    // Неизвестный провайдер и неподдерживаемый метод закрыты.
    assert.equal((await as('owner', '/content/hugh-providers/unknown',
      {method: 'PUT', body: {revision: 0, baseUrl: 'https://api.deepseek.com/v1', modelId: 'm'}})).status, 404);
    assert.equal((await as('owner', '/content/hugh-providers/deepseek')).status, 405);
    // Проверка соединения требует CSRF и не выполняется клиентом.
    assert.equal((await as('client', '/content/hugh-providers/deepseek/check', {method: 'POST'})).status, 403);
    assert.equal((await as('owner', '/content/hugh-providers/deepseek/check',
      {method: 'POST', headers: {'x-csrf-token': 'wrong'}})).status, 403);
  });
