'use strict';

/* Сквозная проверка на НАСТОЯЩЕМ серверном контракте, а не на заглушке: поднимается реальный
   модуль ops/content/project-chat в памяти, перед ним — обычный http-сервер на loopback,
   к нему ходит настоящий коннектор со своим агентом-процессом.

   Что доказывает этот тест: при явном включении режима на сервере внешний ИИ берёт задание
   своей компании, готовит ответ и возвращает его ровно один раз; ответ попадает в комнату
   и в существующую исходящую очередь Telegram. Второй очереди и второго отправителя нет.

   Чего он не доказывает: работоспособности в production. Ключи здесь тестовые, компания — тестовая,
   боевой сервер не затрагивается.
   Запуск: node --test ops/hugh-agent-connector/end-to-end.test.js
   Процесс обязан завершаться сам. Уборка регистрируется через t.after СРАЗУ после создания
   каждого ресурса — тогда упавшая проверка между двумя созданиями всё равно закроет всё,
   и падение не маскируется «зависанием» без внятной ошибки. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');

const { createAuthStore } = require('../content/auth-store');
const { createProjectChat } = require('../content/project-chat');
const { loadConfig, readWorkerKey } = require('./config');
const { createConnector } = require('./connector');

const HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 7).toString('base64url')}$${Buffer.alloc(32, 9).toString('base64url')}`;
const ROOM = 'palitra-love';
const OTHER = 'alvi';
const WORKER_KEY = 'trusted-agent-key-0123456789abcd';
const KEY_SHA = crypto.createHash('sha256').update(WORKER_KEY).digest('hex');

const requireSession = (request) => request.session;
const requireCsrf = () => {};
const sendJson = (response, status, payload, headers) => { response.statusCode = status; response.payload = payload; response.headers = headers; };

/* Кабинет в памяти + http-фасад ровно на четыре операции контракта. */
async function startServer({ trusted }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hac-e2e-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const authStore = createAuthStore(db, `vlad:owner:${HASH}`);
  const chat = createProjectChat({ db, authStore, assetsDir: dir, runnerUrl: 'http://hugh-runtime:8080',
    chatApiKey: 'secret-key', requireSession, requireCsrf, sendJson,
    readBody: async (request) => request.body, fetchImpl: async () => { throw new Error('серверный путь не используется'); },
    statusTtl: 0, localWorker: { keySha256: KEY_SHA, companies: [ROOM, OTHER], trustedAgentCompanies: trusted } });

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const proxy = new Readable({ read() { this.push(Buffer.concat(chunks)); this.push(null); } });
    proxy.method = request.method;
    proxy.headers = request.headers;
    const out = { statusCode: 0, payload: null, headers: null };
    try {
      await chat.localWorker.handle(proxy, out, new URL(`http://x${request.url}`));
      response.writeHead(out.statusCode || 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(out.payload ?? {}));
    } catch (error) {
      response.writeHead(error.status || 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'failed' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { db, chat, authStore, dir, port: server.address().port,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) };
}

function connectorRoot(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hac-cli-'));
  fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secrets', 'worker-key.txt'), WORKER_KEY);
  fs.writeFileSync(path.join(dir, 'secrets', 'agent-key.txt'), 'test-agent-secret');
  fs.writeFileSync(path.join(dir, 'bin', 'agent.js'), `
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (process.argv.includes('--version')) { process.stdout.write('test-agent 1.0\\n'); process.exit(0); }
  const payload = JSON.parse(input);
  const last = payload.messages[payload.messages.length - 1].content;
  process.stdout.write(JSON.stringify({ text: 'Ответ на: ' + last, model: 'test-model-1' }) + '\\n');
});
`);
  const config = { schema: 1, endpoint: `http://127.0.0.1:${port}/content/project-chat-worker`,
    keyFile: 'secrets/worker-key.txt', companies: [ROOM], stateDir: 'state', allowInsecureLoopback: true,
    jobTimeoutMs: 20000, heartbeatIntervalMs: 5000, renewIntervalMs: 5000,
    agents: [{ name: 'external', provider: 'testagent', model: '', command: process.execPath,
      args: [path.join(dir, 'bin', 'agent.js')], probeArgs: [path.join(dir, 'bin', 'agent.js'), '--version'],
      input: 'stdin-json', output: 'json', textField: 'text', envPassthrough: ['PATH'],
      secretEnvFrom: { AGENT_KEY: 'secrets/agent-key.txt' } }],
    routing: { default: 'external' } };
  const file = path.join(dir, 'connector.config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const loaded = loadConfig(file);
  return { dir, file, ...loaded };
}

const ask = async (chat, session, text, id, code = ROOM) => {
  const response = { statusCode: 0, payload: null };
  await chat.handle({ method: 'POST', headers: {}, session, body: { text, clientMessageId: id } },
    response, new URL(`http://x/content/project-chat/${code}/messages`));
  assert.equal(response.statusCode, 201);
  return response.payload.message;
};

const assistantReplies = (db) => db.prepare("SELECT text FROM project_chat_messages WHERE author_type='assistant' ORDER BY id").all();

test('сквозной сценарий: включённый режим — один ответ внешнего ИИ в комнате и в очереди Telegram', async (t) => {
  const server = await startServer({ trusted: [ROOM] });
  t.after(() => server.close());
  const owner = { user: server.authStore.getById(1), csrf: 'csrf' };
  server.db.prepare('INSERT OR IGNORE INTO project_chat_rooms(company_code,title,created_at,updated_at) VALUES(?,?,?,?)')
    .run(ROOM, 'Palitra', new Date().toISOString(), new Date().toISOString());
  await ask(server.chat, owner, 'Хью, когда будет готов прайс?', 'question-0001');
  server.db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run('-1001234567890', ROOM);

  const { config, agentByName } = connectorRoot(server.port);
  const connector = createConnector({ config, agentByName, workerKey: readWorkerKey(config) });
  t.after(() => connector.close());
  {
    // Лента участника должна знать режим: подпись под ожидающим вопросом зависит от него.
    const before = await server.chat.snapshot(ROOM, owner.user, {});
    assert.equal(before.ai.mode, 'trusted-agent');
    assert.ok(!JSON.stringify(before.ai).includes('userCode') && !JSON.stringify(before.ai).includes('loginUrl'),
      'кодов и ссылок входа в снимке участника нет');

    const first = await connector.tick();
    assert.equal(first.outcome, 'accepted', 'сервер принял ответ');

    const replies = assistantReplies(server.db);
    assert.equal(replies.length, 1, 'ровно один ответ в комнате');
    // Сервер передаёт переписку с именем автора — агент получил именно вопрос клиента.
    assert.match(replies[0].text, /Ответ на: .*Хью, когда будет готов прайс\?/);
    const outbox = server.db.prepare("SELECT count(*) AS n FROM project_chat_outbox WHERE status<>''").get();
    assert.equal(outbox.n, 1, 'ответ ушёл существующей исходящей очередью, второго отправителя нет');

    // Второй цикл: заданий больше нет, повторного ответа не появляется.
    const second = await connector.tick();
    assert.equal(second.claimed, null);
    assert.equal(assistantReplies(server.db).length, 1);
  }
});

test('сквозной сценарий: режим выключен — тот же коннектор не получает заданий и ничего не пишет клиенту', async (t) => {
  const server = await startServer({ trusted: [] });
  t.after(() => server.close());
  const owner = { user: server.authStore.getById(1), csrf: 'csrf' };
  server.db.prepare('INSERT OR IGNORE INTO project_chat_rooms(company_code,title,created_at,updated_at) VALUES(?,?,?,?)')
    .run(ROOM, 'Palitra', new Date().toISOString(), new Date().toISOString());
  await ask(server.chat, owner, 'Хью, когда будет готов прайс?', 'question-0002');

  const { config, agentByName } = connectorRoot(server.port);
  const connector = createConnector({ config, agentByName, workerKey: readWorkerKey(config) });
  t.after(() => connector.close());
  const outcome = await connector.tick();
  assert.equal(outcome.claimed, null, 'без серверного включения заданий нет');
  assert.equal(assistantReplies(server.db).length, 0, 'клиенту ничего не написано');
  const view = await server.chat.snapshot(ROOM, owner.user, {});
  assert.equal(view.ai.mode, 'isolated-codex', 'по умолчанию режим прежний');
});

test('сквозной сценарий: чужой ключ не пускает коннектор к контракту', async (t) => {
  const server = await startServer({ trusted: [ROOM] });
  t.after(() => server.close());
  const root = connectorRoot(server.port);
  fs.writeFileSync(path.join(root.dir, 'secrets', 'worker-key.txt'), 'another-key-0123456789abcdefgh');
  const connector = createConnector({ config: root.config, agentByName: root.agentByName, workerKey: readWorkerKey(root.config) });
  t.after(() => connector.close());
  // Отказ доступа — явная ошибка настройки, а не спокойный простой: коннектор обязан сказать вслух.
  await assert.rejects(() => connector.tick(), (error) => error.code === 'UNAUTHORIZED' && error.status === 401);
});
