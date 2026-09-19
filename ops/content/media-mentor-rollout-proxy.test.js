'use strict';
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

// Настоящие сервисы контента и CRM: права, принадлежность компании и CSRF проверяются так же,
// как в кабинете. Внешняя сеть перекрыта — раздел внедрения никуда не обращается.
test('внедрение Медиа-наставника через прокси: чтение по праву компании, правка только администратором, CSRF и изоляция',
  {timeout: 60000}, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mentor-rollout-proxy-')), children = [];
    const contentDb = path.join(directory, 'content.sqlite'), crmDb = path.join(directory, 'crm.sqlite');
    const blockedNetwork = path.join(directory, 'blocked-network.log');
    const password = 'Local-mentor-rollout-password', key = randomBytes(32).toString('hex');
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
    // autoposting.view по правилам доступа требует company-information.view — новых прав не заводим.
    const viewer = ['company-information.view', 'autoposting.view'];
    for (const [login, companies, permissions] of [
      ['client', ['avokado'], viewer],
      ['stranger', ['alvi'], viewer],
      ['crmonly', ['avokado'], ['crm.view']],
    ]) auth.create(owner.id, {login, displayName: login, password, companies, permissions}, hashPassword(password));
    authDb.close();

    const crmPort = await freePort(), contentPort = await freePort();
    const crmBase = `http://127.0.0.1:${crmPort}`, contentBase = `http://127.0.0.1:${contentPort}`;
    const preload = path.join(directory, 'local-network-only.cjs');
    await fs.writeFile(preload, `
    'use strict';
    const fs=require('node:fs'),net=require('node:net');
    const allowed=process.env.MENTOR_TEST_ALLOWED_ORIGIN?new URL(process.env.MENTOR_TEST_ALLOWED_ORIGIN):null;
    function blocked(){fs.appendFileSync(${JSON.stringify(blockedNetwork)},'blocked\\n');throw new Error('External network disabled by mentor rollout fixture');}
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed||url.origin!==allowed.origin)blocked();return originalFetch(input,options);};
    const originalConnect=net.Socket.prototype.connect;
    net.Socket.prototype.connect=function(...args){const values=Array.isArray(args[0])?args[0]:args;const options=typeof values[0]==='object'?values[0]:{port:values[0],host:typeof values[1]==='string'?values[1]:'localhost'};
     if(!allowed||options.host!==allowed.hostname||String(options.port)!==allowed.port)blocked();return originalConnect.apply(this,args);};
    require('node:tls').connect=blocked;
    `);
    async function start(file, env, base) {
      let errors = '';
      const child = spawn(process.execPath, ['--require', preload, file],
        {env: {...process.env, ...env}, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
      children.push(child);
      child.stderr.on('data', (chunk) => { errors += chunk; });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (child.exitCode !== null) throw Error('Service failed: ' + errors);
        try { const response = await fetch(base + '/health', {signal: AbortSignal.timeout(500)}); await response.text(); return; }
        catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      throw Error('Service not ready: ' + errors);
    }
    await start(path.join(__dirname, '../crm/server.js'), {PORT: String(crmPort), DATABASE_PATH: crmDb,
      API_KEY: key, RATE_LIMIT_MAX: '10000', STRICT_ORIGIN: '', MENTOR_TEST_ALLOWED_ORIGIN: '',
      LEADS_SMTP_HOST: '', LEADS_SMTP_PORT: '465', LEADS_SMTP_USER: '', LEADS_SMTP_PASSWORD: '',
      LEADS_MAIL_FROM: '', LEADS_NOTIFY_EMAIL: '', LEADS_NOTIFY_EMAIL_ALVI: '', LEADS_NOTIFY_EMAIL_AVOKADO: ''}, crmBase);
    await start(path.join(__dirname, 'server.js'), {PORT: String(contentPort), DATABASE_PATH: contentDb,
      AUTH_USERS: '', API_KEY: '', CRM_URL: crmBase, CRM_API_KEY: key, SEED_DIR: directory,
      ASSETS_DIR: path.join(directory, 'assets'), SESSION_SECRET: randomBytes(32).toString('hex'),
      MENTOR_TEST_ALLOWED_ORIGIN: crmBase, HUGH_RUNNER_URL: '', CHAT_URL: '', CHAT_API_KEY: ''}, contentBase);

    const forged = (permissions = ['autoposting.view'], role = 'owner', companyCodes = ['alvi', 'avokado']) =>
      Buffer.from(JSON.stringify({v: 1, userId: 1, role, permissions, companyCodes})).toString('base64url');
    async function request(base, route, {method = 'GET', body, headers = {}} = {}) {
      const response = await fetch(base + route, {method,
        headers: {...headers, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000)});
      const text = await response.text();
      return {status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers};
    }
    const direct = (route, options = {}) => request(crmBase, route,
      {...options, headers: {'x-api-key': key, 'x-synapse-crm-identity': forged(), ...options.headers}});
    for (const code of ['avokado', 'alvi']) {
      assert.equal((await direct('/companies', {method: 'POST', body: {code, name: 'Local ' + code, timezone: 'UTC'}})).status, 201);
    }
    const sessions = {};
    for (const login of ['owner', 'client', 'stranger', 'crmonly']) {
      const signed = await request(contentBase, '/content/login', {method: 'POST', body: {login, password}});
      assert.equal(signed.status, 200, login);
      const cookie = signed.headers.get('set-cookie').split(';')[0];
      const profile = await request(contentBase, '/content/whoami', {headers: {cookie}});
      sessions[login] = {cookie, 'x-csrf-token': profile.body.csrfToken};
    }
    const through = (who, route, options = {}) => request(contentBase, '/content/crm' + route,
      {...options, headers: {...sessions[who], ...options.headers}});

    const ROOT = '/media-mentor-rollout', STAGES = `${ROOT}/stages`, SURVEY = `${ROOT}/survey`;
    const stageBody = {revision: 0, stages: [{key: 'product_api', status: 'done',
      confirmedOn: '2026-01-01', evidence: 'PRIVATE AVOKADO EVIDENCE'}]};

    // Без сессии кабинет не пускает, а прямой вызов CRM требует ключа сервиса и доверенной личности.
    assert.equal((await request(contentBase, '/content/crm' + ROOT + '?companyCode=avokado',
      {headers: {'x-api-key': key, 'x-synapse-crm-identity': forged()}})).status, 401);
    assert.equal((await request(crmBase, ROOT + '?companyCode=avokado',
      {headers: {'x-synapse-crm-identity': forged()}})).status, 401);
    assert.equal((await request(crmBase, ROOT + '?companyCode=avokado', {headers: {'x-api-key': key}})).status, 403);

    // Компанию нужно выбрать явно, и её код проверяется до любых данных.
    for (const who of ['owner', 'client']) {
      assert.equal((await through(who, ROOT)).status, 400);
      assert.equal((await through(who, ROOT + '?companyCode=bad%2Fcode')).status, 400);
    }

    // Чтение: право раздела публикаций своей компании. Без него и в чужой компании — отказ.
    assert.equal((await through('crmonly', ROOT + '?companyCode=avokado')).status, 403);
    assert.equal((await through('stranger', ROOT + '?companyCode=avokado')).status, 403);
    const read = await through('client', ROOT + '?companyCode=avokado');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.companyCode, 'avokado');
    assert.equal(read.body.revision, 0);
    assert.ok(read.body.stages.every((stage) => stage.status === 'not_started'));
    assert.deepEqual(read.body.tracks.map((track) => track.key), ['product', 'company']);
    assert.match(read.headers.get('cache-control'), /no-store/);

    // Этапы правит только администратор Synapse. Подделанный заголовок личности прав не повышает.
    for (const headers of [{}, {'x-synapse-crm-identity': forged(['autoposting.edit'], 'owner')}]) {
      const denied = await through('client', STAGES + '?companyCode=avokado', {method: 'PUT', body: stageBody, headers});
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.match(denied.body.error, /администратор Synapse/);
    }
    assert.equal((await through('crmonly', STAGES + '?companyCode=avokado', {method: 'PUT', body: stageBody})).status, 403);
    assert.equal((await through('client', ROOT + '?companyCode=avokado')).body.revision, 0, 'отказ ничего не записал');

    // Запись без действительного CSRF-токена не проходит ни у администратора, ни у клиента.
    for (const csrf of ['', 'invalid-fixture-token']) {
      assert.equal((await through('owner', STAGES + '?companyCode=avokado',
        {method: 'PUT', body: stageBody, headers: {'x-csrf-token': csrf}})).status, 403);
    }
    const saved = await through('owner', STAGES + '?companyCode=avokado', {method: 'PUT', body: stageBody});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.progress.product.requiredDone, 1);
    assert.equal(saved.body.progress.company.requiredDone, 0, 'дорожка клиента не поднялась от правки модуля');

    // Проверка состава сохраняется и на маршруте: готовность без свидетельства не принимается.
    const unfounded = await through('owner', STAGES + '?companyCode=avokado',
      {method: 'PUT', body: {revision: 1, stages: [{key: 'company_brief', status: 'done', confirmedOn: '2026-01-01'}]}});
    assert.equal(unfounded.status, 400);
    assert.equal(unfounded.body.details.code, 'VALIDATION_ERROR');

    // Опрос: клиент до него допущен, отказ временной, а не по правам.
    const cycleKey = (await through('client', ROOT + '?companyCode=avokado')).body.survey.cycleKey;
    assert.match(cycleKey, /^avokado:/);
    const answer = {requestId: 'proxy-survey-1', cycleKey, usefulness: 5, improvement: 'Больше примеров'};
    for (const csrf of ['', 'invalid-fixture-token']) {
      assert.equal((await through('client', SURVEY + '?companyCode=avokado',
        {method: 'POST', body: answer, headers: {'x-csrf-token': csrf}})).status, 403);
    }
    assert.equal((await through('crmonly', SURVEY + '?companyCode=avokado', {method: 'POST', body: answer})).status, 403);
    assert.equal((await through('stranger', SURVEY + '?companyCode=avokado', {method: 'POST', body: answer})).status, 403);
    const early = await through('client', SURVEY + '?companyCode=avokado', {method: 'POST', body: answer});
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.equal(early.body.details.code, 'SURVEY_NOT_DUE');

    // Границы компаний: свидетельство одной компании не видно в другой.
    const foreign = await through('owner', ROOT + '?companyCode=alvi');
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.revision, 0);
    assert.doesNotMatch(JSON.stringify(foreign.body), /PRIVATE AVOKADO EVIDENCE/);
    assert.equal((await through('stranger', ROOT + '?companyCode=alvi')).body.revision, 0);
    assert.equal((await through('owner', ROOT + '?companyCode=missing')).status, 404);

    // Служебная сводка и неизвестные методы закрыты.
    assert.equal((await through('owner', ROOT, {method: 'DELETE'})).status, 400);
    assert.equal((await through('owner', SURVEY + '?companyCode=avokado', {method: 'PUT', body: answer})).status, 405);

    assert.equal(await fs.readFile(blockedNetwork, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }), '', 'раздел внедрения не должен обращаться во внешнюю сеть');
  });
