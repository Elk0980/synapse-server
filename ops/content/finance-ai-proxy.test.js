'use strict';

/* Расходы на ИИ и испытания моделей через настоящие сервисы: права владельца, запрет клиенту,
   план против факта, ноль и неизвестность, повторный импорт, валюты.
   Настоящих платежей здесь нет: все записи синтетические и остаются во временной базе. */

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
const SCOPE = '?companyCode=avokado';
const aiSpend = (patch = {}) => ({service: 'test-provider', accountLabel: 'рабочий аккаунт',
  client: 'cli-client', modelId: 'vendor/model-1', mode: 'api', movement: 'consumption',
  costKnown: true, costBasis: 'invoice', sourceCurrency: 'USD', sourceAmount: 2,
  rate: {value: 90, at: '2026-09-19', source: 'Курс банка'}, usage: {input: 100, output: 50},
  confirmation: 'Счёт провайдера', ...patch});
const entry = (patch = {}) => ({type: 'expense', state: 'actual', date: '2026-09-19', amount: 180,
  category: 'API и AI-сервисы', counterparty: '', note: '', dealId: null, ...patch});

test('расходы на ИИ и испытания через /finances: владелец, запрет клиенту, план/факт, ноль, повтор, валюты',
  {timeout: 60000}, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-ai-proxy-')), children = [];
    const contentDb = path.join(directory, 'content.sqlite'), crmDb = path.join(directory, 'crm.sqlite');
    const password = 'Local-finance-ai-password', key = randomBytes(32).toString('hex');
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
      permissions: ['crm.view', 'crm.edit']}, hashPassword(password));
    authDb.close();

    const crmPort = await freePort(), crmBase = `http://127.0.0.1:${crmPort}`;
    async function start(file, env) {
      let errors = '';
      const child = spawn(process.execPath, [file], {env: {...process.env, ...env},
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
      children.push(child);
      child.stderr.on('data', (chunk) => { errors += chunk; });
      child.stdout.setEncoding('utf8');
      await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => finish(Error('Service not ready: ' + errors)), 5000);
        const finish = (error) => {
          clearTimeout(timer);
          child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError);
          child.stdout.resume();
          if (error) reject(error); else resolve();
        };
        const onExit = (code, signal) => finish(Error(`Service exited (${code ?? signal}): ${errors}`));
        const onError = (error) => finish(Error(`Service failed: ${error.message}; ${errors}`));
        const onData = (chunk) => {
          output += chunk;
          if (new RegExp(`слушает порт ${env.PORT}[;,]`).test(output)) finish();
        };
        child.once('exit', onExit); child.once('error', onError); child.stdout.on('data', onData);
      });
    }
    await start(path.join(__dirname, '../crm/server.js'), {PORT: String(crmPort), DATABASE_PATH: crmDb,
      API_KEY: key, RATE_LIMIT_MAX: '10000', STRICT_ORIGIN: '', LEADS_SMTP_HOST: '', LEADS_SMTP_PORT: '465',
      LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '', LEADS_MAIL_FROM: '', LEADS_NOTIFY_EMAIL: '',
      LEADS_NOTIFY_EMAIL_ALVI: '', LEADS_NOTIFY_EMAIL_AVOKADO: ''});
    // CRM уже держит свой порт: второй свободный порт не может оказаться тем же самым.
    const contentPort = await freePort(), contentBase = `http://127.0.0.1:${contentPort}`;
    await start(path.join(__dirname, 'server.js'), {PORT: String(contentPort), DATABASE_PATH: contentDb,
      AUTH_USERS: '', API_KEY: '', CRM_URL: crmBase, CRM_API_KEY: key, SEED_DIR: directory,
      ASSETS_DIR: path.join(directory, 'assets'), SESSION_SECRET: randomBytes(32).toString('hex'),
      HUGH_RUNNER_URL: '', CHAT_URL: '', CHAT_API_KEY: ''});

    const identity = Buffer.from(JSON.stringify({v: 1, userId: 1, role: 'owner', permissions: [],
      companyCodes: ['avokado']})).toString('base64url');
    async function request(base, route, {method = 'GET', body, headers = {}} = {}) {
      const response = await fetch(base + route, {method,
        headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000)});
      const text = await response.text();
      return {status: response.status, body: text ? JSON.parse(text) : null};
    }
    assert.equal((await request(crmBase, '/companies', {method: 'POST',
      headers: {'x-api-key': key, 'x-synapse-crm-identity': identity},
      body: {code: 'avokado', name: 'Local avokado', timezone: 'UTC'}})).status, 201);
    const sessions = {};
    for (const login of ['owner', 'client']) {
      const signed = await request(contentBase, '/content/login', {method: 'POST', body: {login, password}});
      assert.equal(signed.status, 200, login);
      const cookie = (await fetch(`${contentBase}/content/login`, {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify({login, password})}))
        .headers.get('set-cookie').split(';')[0];
      const profile = await request(contentBase, '/content/whoami', {headers: {cookie}});
      sessions[login] = {cookie, 'x-csrf-token': profile.body.csrfToken};
    }
    const through = (who, route, options = {}) => request(contentBase, '/content/crm' + route,
      {...options, headers: {...sessions[who], ...options.headers}});

    // Раздел остаётся owner-only: клиенту закрыт и журнал, и испытания.
    for (const route of ['/finances' + SCOPE, '/ai-trials' + SCOPE]) {
      assert.equal((await through('client', route)).status, 403, route);
    }
    assert.equal((await through('client', '/finances' + SCOPE,
      {method: 'POST', body: {...entry(), requestId: 'client-try', ai: aiSpend()}})).status, 403);

    // Факт и план считаются раздельно.
    const factKey = 'ai-proxy-fact-1';
    const fact = await through('owner', '/finances' + SCOPE,
      {method: 'POST', body: {...entry(), requestId: factKey, ai: aiSpend()}});
    assert.equal(fact.status, 200, JSON.stringify(fact.body));
    assert.equal(fact.body.ai.modelId, 'vendor/model-1');
    await through('owner', '/finances' + SCOPE, {method: 'POST',
      body: {...entry({state: 'planned', amount: 450}), requestId: 'ai-proxy-plan-1',
        ai: aiSpend({sourceAmount: 5})}});
    const report = await through('owner', `/finances${SCOPE}&from=2026-09-01&to=2026-09-30`);
    assert.equal(report.status, 200);
    assert.equal(report.body.ai.actual.spend, 180, 'фактически потрачено — только факт');
    assert.equal(report.body.ai.planned.spend, 450);
    assert.deepEqual(report.body.ai.currencies.USD, {actual: 2, planned: 5}, 'валюта источника сохранена');
    assert.equal(report.body.ai.actual.invoiced, 180);

    // Повторный импорт по тому же ключу не создаёт вторую запись.
    const repeat = await through('owner', '/finances' + SCOPE,
      {method: 'POST', body: {...entry(), requestId: factKey, ai: aiSpend()}});
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.id, fact.body.id);
    assert.equal((await through('owner', `/finances${SCOPE}&from=2026-09-01&to=2026-09-30`)).body.total, 2);

    // Неподтверждённая стоимость: нулём можно, заглушкой нельзя, фактом нельзя.
    const unknown = aiSpend({costKnown: false, costBasis: null, sourceAmount: null, rate: null, confirmation: ''});
    const masked = await through('owner', '/finances' + SCOPE,
      {method: 'POST', body: {...entry({state: 'planned', amount: 900}), requestId: 'ai-proxy-mask', ai: unknown}});
    assert.equal(masked.status, 400);
    assert.match(masked.body.error, /нулевой суммой/);
    const asFact = await through('owner', '/finances' + SCOPE,
      {method: 'POST', body: {...entry({amount: 0}), requestId: 'ai-proxy-fact-unknown', ai: unknown}});
    assert.equal(asFact.status, 400);
    const zero = await through('owner', '/finances' + SCOPE,
      {method: 'POST', body: {...entry({state: 'planned', amount: 0}), requestId: 'ai-proxy-zero', ai: unknown}});
    assert.equal(zero.status, 200, JSON.stringify(zero.body));
    assert.equal(zero.body.amount, 0);
    const withZero = await through('owner', `/finances${SCOPE}&from=2026-09-01&to=2026-09-30`);
    assert.deepEqual([withZero.body.ai.unknown.count, withZero.body.ai.unknown.withoutAmount], [1, 1]);
    assert.equal(withZero.body.ai.actual.spend, 180, 'неизвестность не добавила сумму');

    // Обычная операция без блока ИИ по-прежнему требует положительной суммы.
    assert.equal((await through('owner', '/finances' + SCOPE,
      {method: 'POST', body: {...entry({amount: 0, category: 'Аренда'}), requestId: 'plain-zero'}})).status, 400);

    // Испытания моделей: владелец пишет, повтор не дублирует, выводы считаются с размером выборки.
    const trial = {setId: 'set-a', taskId: 'task-1', provider: 'test-provider', modelId: 'vendor/model-1',
      attempts: 2, durationMs: 1500, success: true, factViolations: 0, isolationViolations: 0,
      manualEdit: false, humanScore: 4, reportRef: 'reports/safe-1', costKnown: true,
      costCurrency: 'USD', costAmount: 0.4, costBasis: 'estimate', verdict: 'accepted', note: 'Принято по фактам'};
    const savedTrial = await through('owner', '/ai-trials' + SCOPE, {method: 'POST', body: trial});
    assert.equal(savedTrial.status, 200, JSON.stringify(savedTrial.body));
    const again = await through('owner', '/ai-trials' + SCOPE, {method: 'POST', body: trial});
    assert.equal(again.body.id, savedTrial.body.id, 'повторный импорт испытания не дублируется');
    // Неизвестная стоимость записывается без суммы: сумма при costKnown=false не принимается.
    assert.equal((await through('owner', '/ai-trials' + SCOPE, {method: 'POST',
      body: {...trial, taskId: 'task-2', costKnown: false}})).status, 400);
    const second = await through('owner', '/ai-trials' + SCOPE, {method: 'POST', body: {...trial, taskId: 'task-2',
      success: false, humanScore: null, costKnown: false, costAmount: null, costCurrency: null,
      verdict: 'needs_review', note: 'Нарушил факт'}});
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const trials = await through('owner', '/ai-trials' + SCOPE);
    assert.equal(trials.body.total, 2);
    const model = trials.body.conclusions.models[0];
    assert.equal(model.sampleSize, 2);
    assert.equal(model.successRate, 50);
    assert.equal(model.costComplete, false, 'есть строка без стоимости');
    assert.equal(model.costPerAcceptedTask.USD, 0.4);
    assert.match(trials.body.conclusions.basis, /Размер выборки указан/);
    // Секреты и чужие поля в испытание не проходят.
    assert.equal((await through('owner', '/ai-trials' + SCOPE,
      {method: 'POST', body: {...trial, taskId: 'task-3', reportRef: 'sk-0123456789'}})).status, 400);
    assert.equal((await through('owner', '/ai-trials' + SCOPE,
      {method: 'POST', body: {...trial, taskId: 'task-4', clientText: 'сообщение клиента'}})).status, 400);
  });
