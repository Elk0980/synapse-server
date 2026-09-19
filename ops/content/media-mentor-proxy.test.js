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

const BRIEF = {goal: 'Записи на массаж', product: 'Массаж 60 минут', audience: 'Офисные сотрудники',
  pains: ['Болит спина'], confirmedFacts: [{id: 'f1', statement: 'Приём 10:00–21:00', source: 'Карточка ЛК'}],
  assets: [{id: 'a1', title: 'PRIVATE AVOKADO ASSET', kind: 'photo', note: ''}],
  shootingComfort: {level: 'hands_only', notes: ''}, platforms: ['telegram']};
const days = (count = 7) => Array.from({length: count}, (item, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, platform: 'telegram', format: 'post',
  role: 'reach', topic: `Тема дня ${index + 1}`, hook: '', assetId: 'a1', mentorNote: ''}));

// Настоящие сервисы контента и CRM. Проверяются права автопостинга, принадлежность компании,
// CSRF, server-derived автор и то, что согласование плана не включает публикацию.
test('бриф и план Медиа-наставника через прокси: права автопостинга, владелец на решении, CSRF и изоляция',
  {timeout: 60000}, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-mentor-proxy-')), children = [];
    const contentDb = path.join(directory, 'content.sqlite'), crmDb = path.join(directory, 'crm.sqlite');
    const blockedNetwork = path.join(directory, 'blocked-network.log');
    const password = 'Local-media-mentor-password', key = randomBytes(32).toString('hex');
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
    const view = ['company-information.view', 'autoposting.view'];
    const edit = [...view, 'autoposting.edit'];
    for (const [login, companies, permissions] of [
      ['editor', ['avokado'], edit],
      ['viewer', ['avokado'], view],
      ['stranger', ['alvi'], edit],
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
    function blocked(){fs.appendFileSync(${JSON.stringify(blockedNetwork)},'blocked\\n');throw new Error('External network disabled by media mentor fixture');}
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

    const forged = (permissions = ['autoposting.edit'], role = 'owner', companyCodes = ['alvi', 'avokado']) =>
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
    for (const login of ['owner', 'editor', 'viewer', 'stranger', 'crmonly']) {
      const signed = await request(contentBase, '/content/login', {method: 'POST', body: {login, password}});
      assert.equal(signed.status, 200, login);
      const cookie = signed.headers.get('set-cookie').split(';')[0];
      const profile = await request(contentBase, '/content/whoami', {headers: {cookie}});
      sessions[login] = {cookie, 'x-csrf-token': profile.body.csrfToken};
    }
    const through = (who, route, options = {}) => request(contentBase, '/content/crm' + route,
      {...options, headers: {...sessions[who], ...options.headers}});

    const ROOT = '/media-mentor', SCOPE = '?companyCode=avokado';

    // Без сессии кабинет не пускает; прямой вызов CRM требует ключа сервиса и доверенной личности.
    assert.equal((await request(contentBase, '/content/crm' + ROOT + SCOPE,
      {headers: {'x-api-key': key, 'x-synapse-crm-identity': forged()}})).status, 401);
    assert.equal((await request(crmBase, ROOT + SCOPE, {headers: {'x-synapse-crm-identity': forged()}})).status, 401);
    assert.equal((await request(crmBase, ROOT + SCOPE, {headers: {'x-api-key': key}})).status, 403);

    // Компанию нужно выбрать явно, её код проверяется до любых данных.
    assert.equal((await through('owner', ROOT)).status, 400);
    assert.equal((await through('editor', ROOT + '?companyCode=bad%2Fcode')).status, 400);

    // Чтение — по autoposting.view своей компании.
    assert.equal((await through('crmonly', ROOT + SCOPE)).status, 403);
    assert.equal((await through('stranger', ROOT + SCOPE)).status, 403);
    const read = await through('viewer', ROOT + SCOPE);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.companyCode, 'avokado');
    assert.equal(read.body.brief.revision, 0);
    assert.equal(read.body.plan, null);
    assert.equal(read.body.capabilities.httpApi, true);
    assert.equal(read.body.capabilities.publishing, false);
    assert.equal(read.body.capabilities.planApprovalAuthorizesPublishing, false);
    assert.match(read.body.notice, /не разрешение публиковать/);
    assert.match(read.headers.get('cache-control'), /no-store/);

    // Запись — по autoposting.edit, только со своим CSRF-токеном.
    const briefBody = {revision: 0, brief: BRIEF};
    assert.equal((await through('viewer', ROOT + '/brief' + SCOPE, {method: 'PUT', body: briefBody})).status, 403);
    assert.equal((await through('crmonly', ROOT + '/brief' + SCOPE, {method: 'PUT', body: briefBody})).status, 403);
    for (const csrf of ['', 'invalid-fixture-token']) {
      assert.equal((await through('editor', ROOT + '/brief' + SCOPE,
        {method: 'PUT', body: briefBody, headers: {'x-csrf-token': csrf}})).status, 403);
    }
    // Подделанный заголовок личности не повышает права: прокси его перезаписывает.
    assert.equal((await through('viewer', ROOT + '/brief' + SCOPE,
      {method: 'PUT', body: briefBody, headers: {'x-synapse-crm-identity': forged()}})).status, 403);

    const savedBrief = await through('editor', ROOT + '/brief' + SCOPE, {method: 'PUT', body: briefBody});
    assert.equal(savedBrief.status, 200, JSON.stringify(savedBrief.body));
    assert.equal(savedBrief.body.brief.revision, 1);
    // Автор — из сессии, а не из тела запроса.
    assert.equal(savedBrief.body.brief.history[0].actorName, 'editor');
    const stale = await through('editor', ROOT + '/brief' + SCOPE, {method: 'PUT', body: briefBody});
    assert.equal(stale.status, 409);
    assert.equal(stale.body.details.code, 'REVISION_CONFLICT');

    const planBody = {planRevision: 0, briefRevision: 1, days: days()};
    assert.equal((await through('viewer', ROOT + '/plan' + SCOPE, {method: 'PUT', body: planBody})).status, 403);
    const savedPlan = await through('editor', ROOT + '/plan' + SCOPE, {method: 'PUT', body: planBody});
    assert.equal(savedPlan.status, 200, JSON.stringify(savedPlan.body));
    assert.equal(savedPlan.body.plan.revision, 1);
    assert.equal(savedPlan.body.plan.windowDays, 7);
    assert.equal(savedPlan.body.approval.status, 'pending');
    const shortPlan = await through('editor', ROOT + '/plan' + SCOPE,
      {method: 'PUT', body: {planRevision: 1, briefRevision: 1, days: days(6)}});
    assert.equal(shortPlan.status, 400);

    // Решение по версии плана — только владелец, даже с правом autoposting.edit.
    const decision = {planRevision: 1, briefRevision: 1, decision: 'approved', comment: 'Берём в работу'};
    const deniedDecision = await through('editor', ROOT + '/plan/decision' + SCOPE, {method: 'POST', body: decision});
    assert.equal(deniedDecision.status, 403);
    assert.match(deniedDecision.body.error, /только владелец/);
    assert.equal((await through('editor', ROOT + '/plan/decision' + SCOPE,
      {method: 'POST', body: decision, headers: {'x-synapse-crm-identity': forged()}})).status, 403);
    for (const csrf of ['', 'invalid-fixture-token']) {
      assert.equal((await through('owner', ROOT + '/plan/decision' + SCOPE,
        {method: 'POST', body: decision, headers: {'x-csrf-token': csrf}})).status, 403);
    }
    assert.equal((await through('editor', ROOT + SCOPE)).body.approval.status, 'pending', 'отказ ничего не решил');

    const approved = await through('owner', ROOT + '/plan/decision' + SCOPE, {method: 'POST', body: decision});
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.approval.status, 'approved');
    assert.equal(approved.body.approval.actorName, 'owner');
    // Согласование плана не включает публикацию и не создаёт карточек автопостинга.
    assert.equal(approved.body.capabilities.publishing, false);
    assert.equal(approved.body.capabilities.planApprovalAuthorizesPublishing, false);
    const posts = await through('owner', '/autoposting/posts?companyCode=avokado');
    assert.equal(posts.status, 200);
    assert.deepEqual(posts.body.posts, [], 'само согласование не создаёт карточек: перенос — отдельное действие');

    // Перенос согласованной версии в черновики: право правки автопостинга, CSRF, без публикации.
    const transferBody = {planRevision: 1, briefRevision: 1};
    assert.equal((await through('viewer', ROOT + '/plan/transfer' + SCOPE, {method: 'POST', body: transferBody})).status, 403);
    assert.equal((await through('crmonly', ROOT + '/plan/transfer' + SCOPE, {method: 'POST', body: transferBody})).status, 403);
    for (const csrf of ['', 'invalid-fixture-token']) {
      assert.equal((await through('editor', ROOT + '/plan/transfer' + SCOPE,
        {method: 'POST', body: transferBody, headers: {'x-csrf-token': csrf}})).status, 403);
    }
    assert.deepEqual((await through('owner', '/autoposting/posts?companyCode=avokado')).body.posts, [],
      'до переноса черновиков нет');

    const moved = await through('editor', ROOT + '/plan/transfer' + SCOPE, {method: 'POST', body: transferBody});
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(moved.created, undefined);
    assert.equal(moved.body.created, true);
    assert.equal(moved.body.posts.length, 7);
    assert.equal(moved.body.createsPublications, false);
    assert.equal(moved.body.actorName, 'editor');
    assert.ok(moved.body.posts.every((post) => post.status === 'draft' && post.scheduledAt === null &&
      post.text === '' && post.platformIds.length === 0 && post.mediaUrls.length === 0));
    assert.ok(moved.body.posts.every((post) => post.readiness.ready === false));

    // Повтор не создаёт дубли: тех же семь карточек, отчёт честно говорит, что перенос уже был.
    const repeat = await through('editor', ROOT + '/plan/transfer' + SCOPE, {method: 'POST', body: transferBody});
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.created, false);
    assert.equal(repeat.body.alreadyTransferred, true);
    assert.deepEqual(repeat.body.postIds, moved.body.postIds);
    const queue = await through('owner', '/autoposting/posts?companyCode=avokado');
    assert.equal(queue.body.posts.length, 7, 'повтор не добавил карточек');
    assert.ok(queue.body.posts.every((post) => post.status === 'draft'));

    // Контекст черновика: задание дня и исходник восстанавливаются из неизменяемых версий.
    const draftId = moved.body.postIds[0];
    const context = await through('viewer', `${ROOT}/plan/transfer/${draftId}${SCOPE}`);
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.postId, draftId);
    assert.deepEqual([context.body.planRevision, context.body.briefRevision], [1, 1]);
    assert.equal(context.body.day.topic, 'Тема дня 1');
    assert.deepEqual(context.body.asset, {id: 'a1', title: 'PRIVATE AVOKADO ASSET', kind: 'photo', note: ''});
    assert.equal(context.body.assetIsMedia, false);
    assert.equal(context.body.brief.audience, BRIEF.audience, 'аудитория брифа доступна целиком');
    // Указатель на самой карточке называет обе версии и конкретный исходник.
    assert.match(moved.body.posts[0].meta.methodSource, /план v1 · бриф v1 .* исходник a1/);
    // Чужая компания контекст не получает.
    assert.equal((await through('stranger', `${ROOT}/plan/transfer/${draftId}?companyCode=alvi`)).status, 404);
    assert.equal((await through('crmonly', `${ROOT}/plan/transfer/${draftId}${SCOPE}`)).status, 403);

    // Приём материалов — существующий механизм автопостинга, второго склада нет.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    const upload = async (who, query, body, type = 'image/jpeg') => {
      const response = await fetch(`${contentBase}/content/publishing-assets${query}`,
        {method: 'POST', headers: {...sessions[who], 'content-type': type}, body,
          signal: AbortSignal.timeout(8000)});
      const text = await response.text();
      return {status: response.status, body: text ? JSON.parse(text) : null};
    };
    assert.equal((await upload('viewer', '?companyCode=avokado', jpeg)).status, 403, 'нужно право правки');
    assert.equal((await upload('stranger', '?companyCode=avokado', jpeg)).status, 403, 'чужая компания');
    assert.equal((await upload('editor', '?companyCode=avokado', Buffer.alloc(32), 'image/jpeg')).status, 415,
      'подпись файла проверяется');
    assert.equal((await upload('editor', '?companyCode=avokado', jpeg, 'application/pdf')).status, 415);
    const stored = await upload('editor', '?companyCode=avokado', jpeg);
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    assert.match(stored.body.url, /\/content\/publishing-assets\/avokado\//);

    // Материал прикладывается к той же карточке существующим маршрутом автопостинга.
    const beforeMaterial = await through('viewer', `${ROOT}/plan/transfer/${draftId}${SCOPE}`);
    assert.equal(beforeMaterial.body.material.hasMedia, false);
    assert.equal(beforeMaterial.body.asset.title, 'PRIVATE AVOKADO ASSET');
    assert.deepEqual(beforeMaterial.body.material.mediaUrls, [], 'описание исходника не выдано за файл');
    const attached = await through('editor', `/autoposting/posts/${draftId}${SCOPE}`,
      {method: 'PATCH', body: {revision: beforeMaterial.body.material.postRevision, mediaUrls: [stored.body.url]}});
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    const afterMaterial = await through('viewer', `${ROOT}/plan/transfer/${draftId}${SCOPE}`);
    assert.equal(afterMaterial.body.material.hasMedia, true);
    assert.deepEqual(afterMaterial.body.material.mediaUrls, [stored.body.url]);
    assert.equal(afterMaterial.body.asset.title, 'PRIVATE AVOKADO ASSET', 'задание не изменилось');
    const withMaterial = await through('viewer', ROOT + SCOPE);
    assert.equal(withMaterial.body.transfer.awaitingMaterial, 6);
    assert.equal(withMaterial.body.transfer.current.items[0].hasMedia, true);
    // Карточка так и осталась черновиком: материал не публикует.
    assert.equal(attached.body.status, 'draft');
    assert.equal(attached.body.scheduledAt, null);

    // Устаревшая версия плана не переносится.
    const staleTransfer = await through('editor', ROOT + '/plan/transfer' + SCOPE,
      {method: 'POST', body: {planRevision: 99, briefRevision: 1}});
    assert.equal(staleTransfer.status, 409);
    assert.equal(staleTransfer.body.details.code, 'STALE_PLAN');

    // Границы компаний: бриф и исходники одной компании не видны в другой.
    const foreign = await through('owner', ROOT + '?companyCode=alvi');
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.brief.revision, 0);
    assert.doesNotMatch(JSON.stringify(foreign.body), /PRIVATE AVOKADO ASSET/);
    assert.equal((await through('owner', ROOT + '?companyCode=missing')).status, 404);
    assert.equal((await through('stranger', ROOT + '?companyCode=alvi')).status, 200, 'своя компания открыта');

    // Соседний раздел внедрения не перехвачен новым маршрутом.
    const rollout = await through('viewer', '/media-mentor-rollout' + SCOPE);
    assert.equal(rollout.status, 200);
    assert.deepEqual(rollout.body.tracks.map((track) => track.key), ['product', 'company']);

    assert.equal(await fs.readFile(blockedNetwork, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }), '', 'бриф, план и согласование не должны обращаться во внешнюю сеть');
  });
