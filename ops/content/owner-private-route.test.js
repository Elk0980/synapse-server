'use strict';
/* Личная переписка владельца на НАСТОЯЩЕМ сервисе контента: реальный процесс, реальные
   маршруты, реальные cookie-сессии и CSRF, реальная база. Модель не настроена, поэтому
   обращение честно отказывает — и именно это проверяется: вопрос сохранён, ответ не выдуман,
   личный текст не виден ни клиенту, ни в маршрутах общего чата.
   Живых обращений к провайдерам и платежей нет. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { randomBytes } = require('node:crypto'), { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('./auth-store'), { hashPassword } = require('./passwords');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const SECRET = 'Личная заметка владельца, клиенту не показывать';

test('маршруты личной переписки на настоящем сервисе: владелец, CSRF, никакой утечки клиенту',
  { timeout: 60000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-chat-route-')), children = [];
    const contentDb = path.join(directory, 'content.sqlite');
    const password = 'Local-owner-chat-password';
    t.after(async () => {
      for (const child of children.reverse()) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill(); await exited;
        }
      }
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(directory, { recursive: true, force: true });
    });
    const authDb = new DatabaseSync(contentDb);
    const auth = createAuthStore(authDb, `owner:owner:${hashPassword(password)}`), owner = auth.getByLogin('owner');
    // Клиент с доступом к своей компании и правами чата: именно он не должен попасть в личное.
    auth.create(owner.id, { login: 'client', displayName: 'client', password, companies: ['alvi'],
      permissions: ['chat.view', 'chat.reply'] }, hashPassword(password));
    authDb.close();

    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    let errors = '';
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')],
      { env: { ...process.env, PORT: String(port), DATABASE_PATH: contentDb, AUTH_USERS: '', API_KEY: '',
        CRM_URL: '', CRM_API_KEY: '', SEED_DIR: directory, ASSETS_DIR: path.join(directory, 'assets'),
        SESSION_SECRET: randomBytes(32).toString('hex'),
        // Ни рантайма, ни резервных провайдеров: обращение к модели заведомо недоступно.
        HUGH_RUNTIME_URL: '', HUGH_FALLBACK_PROVIDERS: '', CHAT_URL: '', CHAT_API_KEY: '' },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    children.push(child);
    child.stderr.on('data', (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode !== null) throw Error('Сервис не поднялся: ' + errors);
      try { const probe = await fetch(base + '/health', { signal: AbortSignal.timeout(500) }); await probe.text(); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }

    async function request(route, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(base + route, { method,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      return { status: response.status, text, body: text ? JSON.parse(text) : null };
    }
    const sessions = {};
    for (const login of ['owner', 'client']) {
      const signed = await fetch(`${base}/content/login`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) });
      assert.equal(signed.status, 200, login);
      const cookie = signed.headers.get('set-cookie').split(';')[0];
      const profile = await request('/content/whoami', { headers: { cookie } });
      sessions[login] = { cookie, 'x-csrf-token': profile.body.csrfToken };
    }
    const as = (who, route, options = {}) => request(route, { ...options, headers: { ...sessions[who], ...options.headers } });

    // Без сессии закрыто, клиенту закрыто — на всех трёх маршрутах.
    assert.equal((await request('/content/owner-chat')).status, 401);
    assert.equal((await request('/content/owner-chat/alvi')).status, 401);
    for (const route of ['/content/owner-chat', '/content/owner-chat/alvi']) {
      const denied = await as('client', route);
      assert.equal(denied.status, 403, route);
      assert.match(denied.body.error, /только владельцу/);
    }
    assert.equal((await as('client', '/content/owner-chat/alvi/messages',
      { method: 'POST', body: { text: 'Пробую войти' } })).status, 403);

    // Владелец видит свою пустую личную ветку и перечень проектов.
    const opened = await as('owner', '/content/owner-chat/alvi');
    assert.equal(opened.status, 200, opened.text);
    assert.equal(opened.body.audience, 'owner-private');
    assert.match(opened.body.audienceLabel, /Клиент её не видит/);
    assert.deepEqual(opened.body.messages, []);
    assert.equal(opened.body.handoff.enabled, false);
    assert.equal(opened.body.ask.state, 'idle');

    // Запись без действительного CSRF-токена не проходит.
    for (const csrf of ['', 'wrong-token']) {
      const denied = await as('owner', '/content/owner-chat/alvi/messages',
        { method: 'POST', headers: { 'x-csrf-token': csrf }, body: { text: SECRET } });
      assert.equal(denied.status, 403, `csrf=${csrf}`);
    }
    // Неизвестный проект не создаёт ветку даже владельцу.
    assert.equal((await as('owner', '/content/owner-chat/no-such-company')).status, 404);
    // Посторонние поля в теле не принимаются.
    assert.equal((await as('owner', '/content/owner-chat/alvi/messages',
      { method: 'POST', body: { text: SECRET, audience: 'client-shared' } })).status, 400);

    // Модель не настроена: обращение честно отказывает, ответ не выдумывается.
    const sent = await as('owner', '/content/owner-chat/alvi/messages',
      { method: 'POST', body: { text: SECRET, requestId: 'route-req-1' } });
    assert.ok([502, 503].includes(sent.status), `ожидался честный отказ, получено ${sent.status}: ${sent.text}`);
    assert.equal(sent.text.includes(SECRET), false, 'текст вопроса не пересказывается в ошибке');

    // Вопрос сохранён и виден как оставшийся без ответа, повтор предлагается.
    const waiting = await as('owner', '/content/owner-chat/alvi');
    assert.equal(waiting.status, 200);
    assert.deepEqual(waiting.body.messages.map((item) => item.text), [SECRET]);
    assert.equal(waiting.body.messages.every((item) => item.author === 'owner'), true, 'ответа нет');
    assert.equal(waiting.body.ask.canRetry, true);
    assert.ok(['failed', 'stalled'].includes(waiting.body.ask.state));

    // Повтор доступен владельцу и по-прежнему закрыт клиенту.
    assert.equal((await as('client', '/content/owner-chat/alvi/retry', { method: 'POST' })).status, 403);
    const retried = await as('owner', '/content/owner-chat/alvi/retry', { method: 'POST' });
    assert.ok([502, 503].includes(retried.status), `повтор должен честно отказать: ${retried.status}`);
    const afterRetry = await as('owner', '/content/owner-chat/alvi');
    assert.deepEqual(afterRetry.body.messages.map((item) => item.text), [SECRET], 'вопрос не задвоился');

    // Главное: личного текста нет ни в одном клиентском маршруте проекта.
    for (const who of ['client', 'owner']) {
      for (const route of ['/content/project-chat/alvi', '/content/project-chat/alvi/messages']) {
        const shared = await as(who, route);
        assert.ok([200, 403].includes(shared.status), `${who} ${route} → ${shared.status}`);
        assert.equal(shared.text.includes(SECRET), false, `личный текст виден в ${route} у ${who}`);
      }
    }
    // И в личной ветке второй компании его тоже нет.
    const other = await as('owner', '/content/owner-chat/avokado');
    assert.equal(other.status, 200);
    assert.equal(other.text.includes(SECRET), false, 'история одного проекта не видна в другом');
  });
