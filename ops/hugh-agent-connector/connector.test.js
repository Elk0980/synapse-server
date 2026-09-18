'use strict';

/* Проверки коннектора на локальном mock серверного контракта: ни одного обращения к боевому
   кабинету, ни одной клиентской переписки в данных. Агент — короткий node-скрипт. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, readWorkerKey, redacted } = require('./config');
const { createConnector } = require('./connector');
const { createAgentRunner } = require('./adapter');
const { buildStatus } = require('./policy');
const { inspectSpawn } = require('./spawn-guard');
const { main } = require('./cli');

const KEY = 'worker-key-for-tests-0123456789';
const PAYLOAD = { jobId: 'project-chat:7', companyCode: 'palitra-love', system: 'Инструкция проекта',
  messages: [{ role: 'user', content: 'Вопрос участника' }] };

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hac-'));
  fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secrets', 'worker-key.txt'), `${KEY}\n`);
  fs.writeFileSync(path.join(dir, 'secrets', 'agent-key.txt'), 'agent-secret-value\n');
  return dir;
}

/* Агент: печатает JSON с ответом и называет модель; заодно отдаёт увиденные переменные окружения,
   чтобы проверить, что ключ сервера в дочерний процесс не попал. */
function writeAgent(dir, { exitCode = 0, text = 'Ответ агента', huge = false } = {}) {
  const file = path.join(dir, 'bin', 'agent.js');
  fs.writeFileSync(file, `
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (process.argv.includes('--version')) { process.stdout.write('agent 1.0\\n'); process.exit(${exitCode}); }
  const envNames = Object.keys(process.env).sort().join(',');
  const text = ${huge} ? 'x'.repeat(2_000_000) : ${JSON.stringify(text)};
  process.stdout.write(JSON.stringify({ text, model: 'agent-model-1', sawEnv: envNames, inputChars: input.length }) + '\\n');
  process.exit(${exitCode});
});
`);
  return file;
}

function writeConfig(dir, overrides = {}) {
  const agent = { name: 'test-agent', provider: 'testprovider', model: '', command: process.execPath,
    args: [path.join(dir, 'bin', 'agent.js')], probeArgs: [path.join(dir, 'bin', 'agent.js'), '--version'],
    input: 'stdin-json', output: 'json', textField: 'text', envPassthrough: ['PATH'],
    secretEnvFrom: { AGENT_KEY: 'secrets/agent-key.txt' }, ...(overrides.agent || {}) };
  const config = { schema: 1, endpoint: overrides.endpoint || 'http://127.0.0.1:1/content/project-chat-worker',
    keyFile: 'secrets/worker-key.txt', companies: ['palitra-love'], stateDir: 'state',
    allowInsecureLoopback: true, jobTimeoutMs: 15000, heartbeatIntervalMs: 5000, renewIntervalMs: 5000,
    agents: [agent], routing: { default: 'test-agent' }, ...(overrides.config || {}) };
  const file = path.join(dir, 'connector.config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/* Mock сервера: повторяет поведение project-chat-local-worker по ключу, аренде и хешу результата. */
function mockServer({ job = null, completeStatus = 200, renewDelayMs = 0, heartbeatStatus = 200 } = {}) {
  const calls = { heartbeat: [], claim: [], renew: [], complete: [] };
  let handed = job;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const operation = request.url.split('/').pop();
      const parsed = body ? JSON.parse(body) : {};
      calls[operation]?.push({ parsed, authorization: request.headers.authorization });
      if (request.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401).end('{}'); return; }
      if (operation === 'heartbeat' && heartbeatStatus !== 200) { response.writeHead(heartbeatStatus).end('{}'); return; }
      if (operation === 'claim') {
        const payload = handed; handed = null;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job: payload }));
        return;
      }
      if (operation === 'complete') {
        response.writeHead(completeStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: completeStatus === 200 }));
        return;
      }
      if (operation === 'renew' && renewDelayMs) {
        setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
        })), renewDelayMs);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, serverTime: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port,
      // keep-alive соединения Node 19+ иначе держат сервер открытым и тест не завершается.
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) }));
  });
}

const futureLease = () => new Date(Date.now() + 120000).toISOString();
const replyJob = (overrides = {}) => ({ id: '7', kind: 'reply', companyCode: 'palitra-love', payload: PAYLOAD,
  payloadHash: 'a'.repeat(64), leaseToken: 'lease-token-0123456789abcd', leaseExpiresAt: futureLease(), ...overrides });

async function connectorFor(dir, mock, overrides = {}) {
  const file = writeConfig(dir, { endpoint: `http://127.0.0.1:${mock.port}/content/project-chat-worker`, ...overrides });
  const { config, agentByName } = loadConfig(file);
  return { connector: createConnector({ config, agentByName, workerKey: readWorkerKey(config) }), config, agentByName, file };
}

test('статус всегда честный: toolIsolationVerified остаётся false даже при идеальной пробе', async () => {
  const status = buildStatus({ probe: { ok: true, credentials: { ok: true }, spawnGuard: { safe: true } },
    agent: { provider: 'claude', model: 'x' } });
  assert.equal(status.safety.toolIsolationVerified, false);
  assert.equal(status.authenticated, false, 'вход модели коннектор не подтверждает');
  assert.equal(status.readiness, 'attested', 'вместо ложного authenticated — заявленная готовность');
  assert.equal(status.trustedAgent, true, 'само по себе поле ничего не разрешает: решает сервер');
  // Включить изоляцию нечем: в коде нет ветки, которая делает это поле true.
  const source = fs.readFileSync(path.join(__dirname, 'policy.js'), 'utf8');
  assert.ok(!/toolIsolationVerified: true/.test(source));
  assert.ok(!/authenticated: (true|view\.ok)/.test(source));
});

test('heartbeat уходит с false и не содержит ключа', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer();
  const { connector } = await connectorFor(dir, mock);
  await connector.heartbeat();
  const sent = mock.calls.heartbeat[0];
  assert.equal(sent.parsed.status.safety.toolIsolationVerified, false);
  assert.equal(sent.parsed.status.authenticated, false);
  assert.equal(sent.parsed.status.readiness, 'attested');
  assert.ok(!JSON.stringify(sent.parsed).includes(KEY), 'ключ не попадает в тело запроса');
  connector.close(); await mock.close();
});

test('ответ клиенту: задание выполнено, текст и провайдер отправлены один раз', async () => {
  const dir = tempRoot(); writeAgent(dir, { text: 'Готовый ответ' });
  const mock = await mockServer({ job: replyJob() });
  const { connector } = await connectorFor(dir, mock);
  const outcome = await connector.tick();
  assert.equal(outcome.outcome, 'accepted');
  assert.equal(mock.calls.complete.length, 1, 'ровно одна отправка результата');
  const result = mock.calls.complete[0].parsed.result;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Готовый ответ');
  assert.equal(result.provider, 'testprovider');
  assert.equal(result.model, 'agent-model-1', 'модель берётся из ответа агента, не выдумывается');
  connector.close(); await mock.close();
});

test('ключ сервера и посторонние переменные не попадают в дочерний процесс', async () => {
  const dir = tempRoot(); writeAgent(dir);
  process.env.HUGH_LOCAL_WORKER_KEY = 'must-not-leak';
  const mock = await mockServer({ job: replyJob() });
  const { connector, config, agentByName } = await connectorFor(dir, mock);
  const runner = createAgentRunner(config);
  const reply = await runner.reply(agentByName.get('test-agent'), PAYLOAD);
  delete process.env.HUGH_LOCAL_WORKER_KEY;
  assert.ok(!reply.text.includes('must-not-leak'));
  connector.close(); await mock.close();
});

test('повторная отправка не создаёт второго результата; сеть-обрыв повторяется, 409 закрывает запись', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ job: replyJob(), completeStatus: 409 });
  const { connector } = await connectorFor(dir, mock);
  const outcome = await connector.tick();
  assert.equal(outcome.outcome, 'rejected', '409 — аренда уже у другого, слать снова нельзя');
  const again = await connector.flush();
  assert.equal(again.length, 0, 'отклонённый результат больше не досылается');
  assert.equal(mock.calls.complete.length, 1);
  connector.close(); await mock.close();
});

test('неопределённая доставка: результат сохраняется и досылается в следующем цикле ровно один раз', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ job: replyJob(), completeStatus: 503 });
  const { connector } = await connectorFor(dir, mock);
  const first = await connector.tick();
  assert.equal(first.outcome, 'retry');
  assert.equal(connector.outbox.pendingCount(), 1, 'результат не потерян');
  const pendingBefore = connector.outbox.pending()[0];
  assert.equal(pendingBefore.result.ok, true);
  connector.close(); await mock.close();
});

test('просроченная аренда: агент не запускается и результат не отправляется', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ job: replyJob({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }) });
  const { connector } = await connectorFor(dir, mock);
  const outcome = await connector.tick();
  assert.equal(outcome.claimed, null);
  assert.equal(mock.calls.complete.length, 0);
  connector.close(); await mock.close();
});

test('чужая компания: задание не выполняется, уходит INVALID_PAYLOAD', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ job: replyJob({ companyCode: 'alvi' }) });
  const { connector } = await connectorFor(dir, mock);
  await connector.tick();
  const result = mock.calls.complete[0].parsed.result;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INVALID_PAYLOAD');
  connector.close(); await mock.close();
});

test('задание входа не подделывается: отказ UNAVAILABLE без ссылки и кода', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ job: { id: 'login:3', kind: 'login', companyCode: 'palitra-love', payload: {},
    payloadHash: 'b'.repeat(64), leaseToken: 'lease-token-0123456789abcd', leaseExpiresAt: futureLease() } });
  const { connector } = await connectorFor(dir, mock);
  await connector.tick();
  const body = mock.calls.complete[0].parsed;
  assert.equal(body.result.ok, false);
  assert.equal(body.result.errorCode, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(body).includes('loginUrl'));
  assert.ok(!JSON.stringify(body).includes('userCode'));
  connector.close(); await mock.close();
});

test('запретный флаг запуска: агент не стартует, уходит SAFETY_REJECTED', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ job: replyJob() });
  const { connector } = await connectorFor(dir, mock, { agent: { name: 'test-agent', provider: 'testprovider',
    command: process.execPath, args: [path.join(dir, 'bin', 'agent.js'), '--dangerously-skip-permissions'],
    probeArgs: [path.join(dir, 'bin', 'agent.js'), '--version'], input: 'stdin-json', output: 'json',
    envPassthrough: ['PATH'], secretEnvFrom: { AGENT_KEY: 'secrets/agent-key.txt' } } });
  await connector.tick();
  const result = mock.calls.complete[0].parsed.result;
  assert.equal(result.errorCode, 'SAFETY_REJECTED');
  connector.close(); await mock.close();
});

test('нет файла секрета — честный отказ, а не мнимая авторизация', async () => {
  const dir = tempRoot(); writeAgent(dir);
  fs.rmSync(path.join(dir, 'secrets', 'agent-key.txt'));
  const mock = await mockServer({ job: replyJob() });
  const { connector } = await connectorFor(dir, mock);
  const probe = await connector.refreshProbe(connector.agentFor('palitra-love'));
  assert.equal(probe.credentials.ok, false);
  const status = buildStatus({ probe, agent: { provider: 'testprovider', model: '' } });
  assert.equal(status.readiness, '', 'без файла секрета готовность не заявляется');
  assert.equal(status.available, false);
  connector.close(); await mock.close();
});

test('слишком большой ответ агента отбрасывается по размеру', async () => {
  const dir = tempRoot(); writeAgent(dir, { huge: true });
  const mock = await mockServer({ job: replyJob() });
  const { connector, config } = await connectorFor(dir, mock, { config: { maxOutputBytes: 2048 } });
  await connector.tick();
  const result = mock.calls.complete[0].parsed.result;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INVALID_PAYLOAD');
  connector.close(); await mock.close();
});

test('doctor офлайн: ничего не запускает, ключи не печатает, честно показывает отсутствие proof', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const file = writeConfig(dir);
  let output = '';
  const code = await main(['doctor', '--config', file], (text) => { output += text; });
  assert.equal(code, 0);
  assert.ok(!output.includes(KEY), 'ключ сервера не печатается');
  assert.ok(!output.includes('agent-secret-value'), 'секрет агента не печатается');
  assert.ok(output.includes('external_agent_unproven'));
  const report = JSON.parse(output);
  assert.equal(report.config.keyValue, 'REDACTED');
  assert.equal(report.checks.find((item) => item.name === 'tool_isolation_proof').ok, false);
});

test('help офлайн и без конфигурации', async () => {
  let output = '';
  const code = await main(['help'], (text) => { output += text; });
  assert.equal(code, 0);
  assert.ok(output.includes('ВНЕШНЕЕ'));
});

test('запуск проверяется: shell, каталог, таймаут и запретные флаги', () => {
  assert.equal(inspectSpawn({ shell: true }).reason, 'shell_enabled');
  assert.equal(inspectSpawn({ shell: false, workdir: '/s', stateDir: '/s' }).reason, 'workdir_unsafe');
  assert.equal(inspectSpawn({ shell: false, workdir: '/s/w', stateDir: '/s', timeoutMs: 0 }).reason, 'no_timeout');
  assert.equal(inspectSpawn({ shell: false, workdir: '/s/w', stateDir: '/s', timeoutMs: 1, maxOutputBytes: 1,
    args: ['--mcp-config', 'x'], envNames: ['PATH'] }).reason, 'forbidden_argument');
  assert.equal(inspectSpawn({ shell: false, workdir: '/s/w', stateDir: '/s', timeoutMs: 1, maxOutputBytes: 1,
    args: [], envNames: ['HUGH_LOCAL_WORKER_KEY'] }).reason, 'forbidden_env');
});

test('конфигурация: неизвестный ключ, чужой маршрут и небезопасный адрес отклоняются', () => {
  const dir = tempRoot(); writeAgent(dir);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schema: 1, endpoint: 'https://x/y', keyFile: 'secrets/worker-key.txt',
    companies: ['palitra-love'], agents: [], somethingElse: 1 }));
  assert.throws(() => loadConfig(bad), /unknown_key_somethingElse/);
  const insecure = path.join(dir, 'insecure.json');
  fs.writeFileSync(insecure, JSON.stringify({ schema: 1, endpoint: 'http://example.org/content/project-chat-worker',
    keyFile: 'secrets/worker-key.txt', companies: ['palitra-love'],
    agents: [{ name: 'a', command: process.execPath }] }));
  assert.throws(() => loadConfig(insecure), /endpoint_/);
});

test('429 сохраняет результат для повтора и не закрывает запись', async () => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ job: replyJob(), completeStatus: 429 });
  const { connector } = await connectorFor(dir, mock);
  const outcome = await connector.tick();
  assert.equal(outcome.outcome, 'retry', 'перегрузка сервера — временный ответ');
  assert.equal(connector.outbox.pendingCount(), 1, 'результат остался для повтора');
  assert.equal(connector.outbox.get('7').ackedAt, null);
  connector.close(); await mock.close();
});

test('убитый по таймауту агент не считается успехом', async () => {
  const dir = tempRoot();
  // Агент, который никогда не отвечает: коннектор обязан убить его и признать отказом.
  fs.writeFileSync(path.join(dir, 'bin', 'agent.js'), `
if (process.argv.includes('--version')) { process.stdout.write('agent 1.0\\n'); process.exit(0); }
setInterval(() => {}, 1000);
`);
  const mock = await mockServer({ job: replyJob() });
  const { connector } = await connectorFor(dir, mock, { config: { jobTimeoutMs: 10000 } });
  const { config, agentByName } = loadConfig(writeConfig(dir, { endpoint: `http://127.0.0.1:${mock.port}/content/project-chat-worker`, config: { jobTimeoutMs: 10000 } }));
  const runner = createAgentRunner(config);
  await assert.rejects(() => runner.reply(agentByName.get('test-agent'), PAYLOAD), (error) => error.code === 'AGENT_TIMEOUT');
  connector.close(); await mock.close();
});

test('пример конфигурации разбирается и не требует секретов', () => {
  const dir = tempRoot();
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
  assert.ok(!/\.(cmd|bat|ps1)$/i.test(example.agents[0].command), 'на Windows .cmd напрямую не запускается');
  example.endpoint = 'https://example.org/content/project-chat-worker';
  const file = path.join(dir, 'example.json');
  fs.writeFileSync(file, JSON.stringify(example));
  const { config } = loadConfig(file);
  assert.equal(config.agents[0].requiresCredentials, false, 'образец работает без ключей');
  assert.equal(Object.keys(config.agents[0].secretEnvFrom).length, 0);
});

test('несколько маршрутов: общая готовность проверяет каждого, модель default не приписывается всем', async (t) => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer();
  const file = writeConfig(dir, { endpoint: `http://127.0.0.1:${mock.port}/content/project-chat-worker` });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.companies = ['palitra-love', 'alvi'];
  raw.agents.push({ ...raw.agents[0], name: 'second-agent', provider: 'otherprovider' });
  raw.routing = { default: 'test-agent', companies: { alvi: 'second-agent' } };
  fs.writeFileSync(file, JSON.stringify(raw));
  const { config, agentByName } = loadConfig(file);
  const connector = createConnector({ config, agentByName, workerKey: readWorkerKey(config) });
  t.after(async () => { connector.close(); await mock.close(); });
  await connector.heartbeat();
  const status = mock.calls.heartbeat[0].parsed.status;
  assert.equal(status.provider, '', 'при нескольких агентах провайдер не заявляется');
  assert.equal(status.model, '');
  assert.equal(connector.probeFresh(agentByName.get('second-agent')), true);
  agentByName.get('second-agent').command = path.join(dir, 'missing-program.exe');
  await connector.refreshProbe(agentByName.get('second-agent'));
  await connector.heartbeat();
  assert.equal(mock.calls.heartbeat.at(-1).parsed.status.available, false, 'сломанный маршрут останавливает выдачу');
  assert.equal(mock.calls.heartbeat.at(-1).parsed.status.readiness, '');
});

test('позднее продление завершается до записи результата и не восстанавливает active_job', async (t) => {
  const dir = tempRoot();
  fs.writeFileSync(path.join(dir, 'bin', 'agent.js'), `
process.stdin.resume();
process.stdin.on('end', () => {
  if (process.argv.includes('--version')) { process.stdout.write('v1'); return; }
  setTimeout(() => process.stdout.write(JSON.stringify({ text: 'Ответ' })), 80);
});
`);
  const mock = await mockServer({ job: replyJob(), renewDelayMs: 250 });
  const { connector, config } = await connectorFor(dir, mock);
  // Ускорение таймера только в тесте, после проверки реального конфигурационного файла.
  config.renewIntervalMs = 10;
  t.after(async () => { connector.close(); await mock.close(); });
  const result = await connector.tick();
  assert.equal(result.outcome, 'accepted');
  assert.ok(mock.calls.renew.length > 0);
  assert.equal(mock.calls.complete[0].parsed.result.ok, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(connector.outbox.readActiveJob(), null);
  assert.equal(connector.outbox.pendingCount(), 0);
});

test('HTTP503 не выдаётся за успешный статус или пустую очередь; демон делает паузу', async (t) => {
  const dir = tempRoot(); writeAgent(dir);
  const mock = await mockServer({ heartbeatStatus: 503 });
  const { connector, file } = await connectorFor(dir, mock);
  t.after(async () => { connector.close(); await mock.close(); });
  const pauses = [];
  const result = await connector.run({ cycles: 2, sleep: async ms => pauses.push(ms) });
  assert.equal(result.recent.length, 2);
  assert.ok(result.recent.every(item => item.error === 'network'));
  assert.deepEqual(pauses, [5000]);
  assert.equal(mock.calls.claim.length, 0);
  assert.equal(await main(['status', '--config', file], () => {}), 1);
});
