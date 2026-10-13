'use strict';

// SC004/FR009: настоящий дочерний server.js, новая временная SQLite и только 127.0.0.1.
// Компании receipt_a/receipt_b и контакты синтетические; SMTP, внешние сервисы и рабочие данные не используются.
// Локальный перезапуск в этом тесте не является рабочим restart/second cycle (SC003) и не доказывает native linkage.

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {lstat, mkdtemp, rm, writeFile} = require('node:fs/promises');
const net = require('node:net');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const test = require('node:test');
const {setTimeout: sleep} = require('node:timers/promises');

const SERVER_PATH = path.join(process.env.RECEIPT_TEST_SOURCE_ROOT || __dirname, 'server.js');
const FIXTURE_PREFIX = 'synapse-lead-intake-';
const FIXTURE_NAME = /^synapse-lead-intake-[A-Za-z0-9]{6}$/;
// Явный список системных переменных; process.env целиком в дочерний процесс не передаётся.
const SYSTEM_ENV = ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME'];
const REQUEST_TIMEOUT_MS = 10000;
const READY_TIMEOUT_MS = 30000;
const EXIT_TIMEOUT_MS = 15000;
const IDENTITY = Buffer.from(JSON.stringify({v: 1, userId: 1, role: 'owner', companyCodes: [], permissions: []}))
  .toString('base64url');
const COMPANY_A = {code: 'receipt_a', name: 'Receipt A (synthetic)', websiteUrl: 'https://receipt-a.test'};
const COMPANY_B = {code: 'receipt_b', name: 'Receipt B (synthetic)', websiteUrl: 'https://receipt-b.test'};
const ORIGIN_A = {Origin: 'https://receipt-a.test'};
const ORIGIN_B = {Origin: 'https://receipt-b.test'};
const RECEIPT_COLUMNS = ['id', 'received_at', 'received_ms', 'company_code', 'lead_id', 'outcome', 'origin_state',
  'writer_version', 'trust', 'declared_source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
  'utm_term', 'landing_host'];
const LABEL_COLUMNS = ['declared_source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'landing_host'];
const EVENT_COLUMNS = ['id', 'session_id', 'kind', 'version', 'occurred_at', 'occurred_ms'];
const COUNTED_TABLES = ['leads', 'stage_history', 'lead_email_outbox', 'revenue_lead_receipts'];
const CRM_FIELDS = ['createdAt', 'name', 'contact', 'source', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent',
  'utmTerm', 'landingPage', 'companyCode'];
// Поддельные «доказательства» публичного клиента: не дают server timestamp, первое касание, native-связь или деньги.
const FORGED_PROOF = {
  receivedAt: '2001-02-03T04:05:06.000Z', receivedMs: 981173106000, createdAt: '2001-02-03T04:05:06.000Z',
  ts: '2001-02-03T04:05:06.000Z', firstTouchAt: '2001-02-03T04:05:06.000Z', recordId: 'yc-record-1',
  visitId: 'yc-visit-1', yclientsClientId: 'yc-client-1', nativeLinks: 'verified',
  leadBinding: {recordId: 'yc-record-1', verified: true}, proof: {kind: 'server', verified: true},
  trust: 'server_verified', outcome: 'created', originState: 'matched', writerVersion: 'forged/v0',
  economics: {cacKopecks: 100, romiBasisPoints: 10000}, paymentKopecks: 100000,
};
const FORGED_VALUES = ['2001-02-03', '981173106000', 'yc-record-1', 'yc-visit-1', 'yc-client-1', 'server_verified',
  'forged/v0'];

const utcDay = () => new Date().toISOString().slice(0, 10);
const plain = (row) => (row ? {...row} : row);
const pick = (row, columns) => Object.fromEntries(columns.map((column) => [column, row[column]]));

test('аварийное завершение HTTP-сервера оставляет незакрытую сессию; новый запуск не заполняет разрыв', async (t) => {
  await withFixture(async (fixture) => {
    const day = utcDay();
    const first = await startServer(fixture);
    await createCompanies(first, [COMPANY_A]);
    const created = await postLead(first, {name:'Синтетика авария',contact:'+7 555 070-00-01',companyCode:COMPANY_A.code},ORIGIN_A);
    assert.equal(created.status,201);
    const db = openFixtureDb(fixture),start = writerStarts(db)[0];
    const lastMs = db.prepare('SELECT MAX(occurred_ms) ms FROM revenue_lead_writer_events WHERE session_id=?').get(start.session_id).ms;
    first.child.kill('SIGKILL');
    const exit = await within(first.exited,EXIT_TIMEOUT_MS);
    assert.ok(exit,'аварийно завершился только собственный child');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM revenue_lead_writer_events WHERE session_id=? AND kind='close'").get(start.session_id).n,0);
    await sleep(25);
    const second = await startServer(fixture);
    const starts=writerStarts(db);assert.equal(starts.length,2);assert.notEqual(starts[1].session_id,start.session_id);assert.ok(starts[1].occurred_ms>lastMs);
    assert.equal(db.prepare('SELECT MAX(occurred_ms) ms FROM revenue_lead_writer_events WHERE session_id=?').get(start.session_id).ms,lastMs);
    const report=await journalReport(second,COMPANY_A.code,day);
    const journal=assertAttemptJournal(t,report,{companyCode:COMPANY_A.code,day,counts:{total:1,created:1,deduplicated:0},legacyLeadRows:1});
    if(utcDay()===day)assert.ok(journal.reasons.includes('writer_coverage_gap'));
  });
});

function childEnv(settings) {
  const env = {};
  for (const name of SYSTEM_ENV) {
    const value = process.env[name];
    if (typeof value === 'string' && value) env[name] = value;
  }
  return {...env, ...settings};
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, null); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX));
  // Windows kill(SIGTERM) не доставляет сигнал JS. Только собственный fixture IPC
  // запускает настоящий production shutdown handler, без нового HTTP endpoint.
  const controlPath = path.join(directory, 'fixture-control.cjs');
  await writeFile(controlPath, "process.on('message',m=>{if(m==='lead-fixture-shutdown')process.emit('SIGTERM')});\n");
  return {
    directory,
    controlPath,
    databasePath: path.join(directory, 'crm.sqlite'),
    apiKey: `synthetic-${randomBytes(24).toString('hex')}`,
    servers: [],
    handles: [],
    triggers: new Set(),
  };
}

async function request(server, method, pathname, {body, headers = {}, api = false, timeoutMs = REQUEST_TIMEOUT_MS} = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    method,
    headers: {
      ...(api ? {'x-api-key': server.apiKey, 'x-synapse-crm-identity': IDENTITY} : {}),
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {status: response.status, body: json};
}

// Публичный POST /leads отправляется без API-ключа и identity.
const postLead = (server, body, headers = {}) => request(server, 'POST', '/leads', {body, headers});

async function waitReady(server) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exit) {
      const spawnError = server.exit.spawnError ? `, spawn=${server.exit.spawnError}` : '';
      throw new Error(`server.js завершился до готовности (code=${server.exit.code}, signal=${server.exit.signal}`
        + `${spawnError}). stderr: ${server.stderr()}`);
    }
    try {
      const response = await request(server, 'GET', '/companies', {api: true, timeoutMs: 1000});
      if (response.status === 200) return;
    } catch {
      // Порт ещё не слушается.
    }
    await sleep(50);
  }
  throw new Error(`server.js не ответил за ${READY_TIMEOUT_MS} мс. stderr: ${server.stderr()}`);
}

async function startServer(fixture, {strict = false} = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', fixture.controlPath, SERVER_PATH], {
    env: childEnv({
      API_KEY: fixture.apiKey,
      DATABASE_PATH: fixture.databasePath,
      PORT: String(port),
      RATE_LIMIT_MAX: '10000',
      STRICT_ORIGIN: strict ? 'true' : '',
    }),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const server = {child, port, apiKey: fixture.apiKey, exit: null, forced: false, log: ''};
  fixture.servers.push(server);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { server.log = (server.log + chunk).slice(-16384); });
  server.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      server.exit = {code, signal};
      resolve(server.exit);
    });
    child.on('error', (error) => {
      // Ошибка kill у живого процесса не считается завершением; только неудачный spawn.
      if (child.pid !== undefined || server.exit) return;
      server.exit = {code: null, signal: null, spawnError: error.code || 'SPAWN_FAILED'};
      resolve(server.exit);
    });
  });
  // Ключ синтетический, но в сообщения об ошибках он всё равно не попадает.
  server.stderr = () => server.log.split(fixture.apiKey).join('[API_KEY]').slice(-4000);
  await waitReady(server);
  return server;
}

// Останавливается только собственный child; при зависании — SIGKILL того же child и ожидание exit.
async function stopServer(server) {
  if (server.exit) return server.exit;
  if (process.platform === 'win32') server.child.send('lead-fixture-shutdown');
  else server.child.kill('SIGTERM');
  const exit = await within(server.exited, EXIT_TIMEOUT_MS);
  if (exit) return exit;
  server.forced = true;
  server.child.kill('SIGKILL');
  return within(server.exited, EXIT_TIMEOUT_MS);
}

function openFixtureDb(fixture) {
  const db = new DatabaseSync(fixture.databasePath);
  fixture.handles.push(db);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

async function removeFixtureDirectory(directory) {
  const root = path.resolve(tmpdir());
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('Фикстура вне временного каталога: удаление отменено');
  }
  if (!FIXTURE_NAME.test(path.basename(target))) throw new Error('Неожиданное имя фикстуры: удаление отменено');
  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Фикстура не обычный каталог: удаление отменено');
  await rm(target, {recursive: true, maxRetries: 3, retryDelay: 100});
}

async function disposeFixture(fixture) {
  const errors = [];
  for (const server of fixture.servers) {
    try {
      if (!await stopServer(server)) errors.push(new Error('Дочерний server.js не завершился после SIGKILL'));
    } catch (error) {
      errors.push(error);
    }
  }
  for (const {db, name} of fixture.triggers) {
    try {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    } catch (error) {
      errors.push(error);
    }
  }
  fixture.triggers.clear();
  for (const db of fixture.handles) {
    try {
      db.close();
    } catch (error) {
      if (error?.code !== 'ERR_INVALID_STATE') errors.push(error);
    }
  }
  fixture.handles.length = 0;
  if (fixture.servers.every((server) => server.exit)) await removeFixtureDirectory(fixture.directory);
  else errors.push(new Error('Дочерний server.js ещё работает: временная база не удаляется'));
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Ошибки очистки фикстуры');
}

async function withFixture(callback) {
  const fixture = await createFixture();
  let failure = null;
  try {
    return await callback(fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await disposeFixture(fixture);
    } catch (cleanupError) {
      if (!failure) throw cleanupError;
      throw new AggregateError([failure, cleanupError], 'Тест и очистка фикстуры завершились ошибками');
    }
  }
}

async function createCompanies(server, companies) {
  for (const company of companies) {
    const response = await request(server, 'POST', '/companies', {body: company, api: true});
    assert.equal(response.status, 201, `компания ${company.code} не создана: HTTP ${response.status}`);
  }
}

function tableCounts(db) {
  return Object.fromEntries(COUNTED_TABLES.map((table) =>
    [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}

const countWhere = (db, sql, ...params) => Number(db.prepare(sql).get(...params).count);
const receiptsFor = (db, leadId) =>
  db.prepare('SELECT * FROM revenue_lead_receipts WHERE lead_id = ? ORDER BY id').all(leadId).map(plain);
const allReceipts = (db) => db.prepare('SELECT * FROM revenue_lead_receipts ORDER BY id').all().map(plain);
const writerEvents = (db) => db.prepare('SELECT * FROM revenue_lead_writer_events ORDER BY id').all().map(plain);
const writerStarts = (db) => db.prepare(
  "SELECT session_id, occurred_ms FROM revenue_lead_writer_events WHERE kind = 'start' ORDER BY id"
).all().map(plain);
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const sessionBoundaries = (db) => countWhere(db,
  "SELECT COUNT(*) AS count FROM revenue_lead_writer_events WHERE kind IN ('start', 'close')");

function assertNoValues(value, forbidden, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  forbidden.forEach((item, index) => {
    // Само значение в сообщение не выводится.
    assert.equal(text.includes(item), false, `${label}: найдено запрещённое значение #${index}`);
  });
}

async function journalReport(server, companyCode, day) {
  const query = new URLSearchParams({companyCode, from: day, to: day, observationTo: day, analysisTimezone: 'UTC'});
  const response = await request(server, 'GET', `/revenue-analytics?${query}`, {api: true});
  assert.equal(response.status, 200, `revenue-analytics: HTTP ${response.status} ${response.body?.code || ''}`);
  return response.body;
}

// DTO из revenue-analytics.js: leadJournal без контактов, попытки отдельно от людей и денег.
function assertAttemptJournal(t, report, {companyCode, day, counts, legacyLeadRows}) {
  assert.equal(report.companyCode, companyCode);
  assert.equal(report.yclients, null, 'без подключения YCLIENTS нет кассовых фактов');
  assert.equal(report.metrika, null);
  assert.equal(report.direct, null);
  assert.equal(report.economics.cac, null, 'CAC недоступен без подтверждённых фактов');
  assert.equal(report.economics.romi, null, 'ROMI недоступен без подтверждённых фактов');
  const journal = report.leadJournal;
  assert.ok(journal, 'leadJournal подключён к отчёту');
  assert.equal(journal.companyCode, companyCode);
  assert.deepEqual(journal.period, {from: day, to: day, timezone: 'UTC'});
  assert.equal(journal.completeness, 'partial');
  assert.equal(journal.countsAreLowerBound, true);
  assert.equal(journal.countBasis, 'accepted_http_attempts_not_unique_leads');
  assert.equal(journal.trust, 'declared_public');
  assert.equal(journal.legacyLeadRowsBasis, 'crm_leads_current_company_created_at_mutable');
  assert.equal(journal.writer.status, 'active');
  assert.equal(journal.writer.fullPeriodCovered, false);
  assert.equal(journal.firstTouch, 'unknown');
  assert.equal(journal.nativeLinks, 'missing');
  assert.equal(journal.leadsWithoutBooking, 'unavailable');
  assert.equal(journal.economics, 'unavailable');
  if (utcDay() !== day) {
    t.diagnostic('Запросы пересекли полночь UTC: проверка счётчиков и period_not_closed пропущена');
    return journal;
  }
  assert.ok(journal.reasons.includes('period_not_closed'), 'текущие сутки не закрыты');
  assert.deepEqual(journal.knownReceiptCounts, counts);
  if (legacyLeadRows !== undefined) assert.equal(journal.legacyLeadRowsCount, legacyLeadRows);
  return journal;
}

test('POST /leads: create 201 и повтор 200 пишут два receipt, исходная CRM-строка не меняется', async () => {
  await withFixture(async (fixture) => {
    const server = await startServer(fixture);
    await createCompanies(server, [COMPANY_A]);
    const db = openFixtureDb(fixture);
    const original = {
      name: 'Синтетический клиент один', contact: '+7 555 010-00-01', companyCode: COMPANY_A.code,
      source: 'site_form', utmSource: 'yandex', utmMedium: 'cpc', utmCampaign: 'spring_a',
      utmContent: 'banner_1', utmTerm: 'massage', landingPage: 'https://receipt-a.test/form',
    };
    const created = await postLead(server, original, ORIGIN_A);
    assert.equal(created.status, 201);
    assert.equal(created.body.deduplicated, false);
    const leadId = created.body.id;
    assert.ok(Number.isSafeInteger(leadId) && leadId > 0);

    // Старые формы повторяют только контакт: имя для найденной заявки не требуется.
    const repeated = await postLead(server, {
      contact: '+7 (555) 010-00-01', companyCode: COMPANY_A.code, utmSource: 'vk', utmCampaign: 'retarget_b',
    }, ORIGIN_A);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.deduplicated, true);
    assert.equal(repeated.body.id, leadId);
    for (const field of CRM_FIELDS) assert.equal(repeated.body[field], created.body[field], `ответ повтора: ${field}`);

    const stored = await request(server, 'GET', `/leads/${leadId}`, {api: true});
    assert.equal(stored.status, 200);
    for (const field of CRM_FIELDS) assert.equal(stored.body[field], created.body[field], `CRM-строка: ${field}`);
    assert.equal(stored.body.utmSource, 'yandex');
    assert.equal(stored.body.utmCampaign, 'spring_a');
    assert.equal(stored.body.stageHistory.length, 1);

    assert.deepEqual(tableCounts(db), {leads: 1, stage_history: 1, lead_email_outbox: 1, revenue_lead_receipts: 2});
    const receipts = receiptsFor(db, leadId);
    assert.deepEqual(receipts.map((row) => row.outcome), ['created', 'deduplicated']);
    assert.deepEqual(receipts.map((row) => row.company_code), [COMPANY_A.code, COMPANY_A.code]);
    assert.deepEqual(receipts.map((row) => row.origin_state), ['matched', 'matched']);
    assert.ok(receipts[1].id > receipts[0].id);
    assert.ok(receipts[1].received_ms >= receipts[0].received_ms);
  });
});

test('метки повторов, PII и поддельные proof-поля не попадают в журнал; отчёт остаётся partial', async (t) => {
  await withFixture(async (fixture) => {
    const server = await startServer(fixture);
    await createCompanies(server, [COMPANY_A]);
    const db = openFixtureDb(fixture);
    const day = utcDay();
    const personal = ['Синтетический клиент два', '+7 555 020-00-02', '75550200002', 'synthetic.person@example.test',
      'synthetic.person%40example.test', 'userinfo-secret', 'private-path', 'phone=', 'frag-secret'];

    const firstStarted = Date.now();
    const created = await postLead(server, {
      name: personal[0], contact: personal[1], companyCode: COMPANY_A.code, source: 'site_form',
      utmSource: 'yandex', utmMedium: 'cpc', utmCampaign: 'spring_a', utmContent: 'banner_1', utmTerm: 'massage',
      landingPage: 'https://receipt-a.test/form', ...FORGED_PROOF,
    }, ORIGIN_A);
    const firstFinished = Date.now();
    assert.equal(created.status, 201);
    assert.equal(Object.hasOwn(created.body, 'receivedAt'), false);
    const createdAtMs = Date.parse(created.body.createdAt);
    assert.ok(createdAtMs >= firstStarted && createdAtMs <= firstFinished, 'created_at задаёт сервер');

    // Повтор без Origin: заявленное originState=matched не принимается.
    const secondStarted = Date.now();
    const repeated = await postLead(server, {
      contact: personal[1], companyCode: COMPANY_A.code, source: 'repeat_form', utmSource: 'vk',
      utmMedium: 'id75550200002', utmCampaign: 'retarget_b', utmContent: '+7 (555) 020-00-02',
      utmTerm: 'synthetic.person@example.test',
      landingPage: 'https://userinfo:userinfo-secret@Receipt-A.test./private-path/75550200002'
        + '?phone=75550200002&email=synthetic.person%40example.test#frag-secret',
      ...FORGED_PROOF,
    });
    const secondFinished = Date.now();
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.deduplicated, true);
    assert.equal(repeated.body.id, created.body.id);

    const receipts = receiptsFor(db, created.body.id);
    assert.equal(receipts.length, 2);
    assert.deepEqual(pick(receipts[0], LABEL_COLUMNS), {
      declared_source: 'site_form', utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'spring_a',
      utm_content: 'banner_1', utm_term: 'massage', landing_host: 'receipt-a.test',
    });
    assert.deepEqual(pick(receipts[1], LABEL_COLUMNS), {
      declared_source: 'repeat_form', utm_source: 'vk', utm_medium: null, utm_campaign: 'retarget_b',
      utm_content: null, utm_term: null, landing_host: 'receipt-a.test',
    });
    assert.deepEqual(receipts.map((row) => row.outcome), ['created', 'deduplicated']);
    assert.deepEqual(receipts.map((row) => row.origin_state), ['matched', 'missing']);
    for (const [receipt, started, finished] of [[receipts[0], firstStarted, firstFinished],
      [receipts[1], secondStarted, secondFinished]]) {
      assert.ok(receipt.received_ms >= started && receipt.received_ms <= finished, 'received_ms задаёт сервер');
      assert.equal(receipt.received_at, new Date(receipt.received_ms).toISOString());
      assert.equal(receipt.trust, 'declared_public');
      assert.equal(receipt.writer_version, 'lead-receipts/v1');
    }
    assert.deepEqual(columnsOf(db, 'revenue_lead_receipts'), RECEIPT_COLUMNS);
    assert.deepEqual(columnsOf(db, 'revenue_lead_writer_events'), EVENT_COLUMNS);
    assertNoValues(allReceipts(db), [...personal, ...FORGED_VALUES], 'revenue_lead_receipts');
    assertNoValues(writerEvents(db), [...personal, ...FORGED_VALUES], 'revenue_lead_writer_events');

    // CRM-строка хранит исходные метки; метки повтора есть только в своём receipt.
    const stored = await request(server, 'GET', `/leads/${created.body.id}`, {api: true});
    assert.equal(stored.status, 200);
    assert.equal(stored.body.source, 'site_form');
    assert.equal(stored.body.utmSource, 'yandex');
    assert.equal(stored.body.utmMedium, 'cpc');
    assert.equal(stored.body.utmCampaign, 'spring_a');
    assert.equal(stored.body.landingPage, 'https://receipt-a.test/form');
    assert.equal(stored.body.createdAt, created.body.createdAt);

    // Чтение отчёта не пишет ни заявок, ни receipts, ни границ сессий.
    const countsBefore = tableCounts(db);
    const boundariesBefore = sessionBoundaries(db);
    const report = await journalReport(server, COMPANY_A.code, day);
    assert.deepEqual(tableCounts(db), countsBefore);
    assert.equal(sessionBoundaries(db), boundariesBefore);
    assertAttemptJournal(t, report, {
      companyCode: COMPANY_A.code, day, counts: {total: 2, created: 1, deduplicated: 1}, legacyLeadRows: 1,
    });
    assertNoValues(report, [...personal, ...FORGED_VALUES], 'revenue-analytics');
  });
});

test('компании A/B и legacy null не смешиваются; receipt хранит компанию момента приёма после PATCH', async (t) => {
  await withFixture(async (fixture) => {
    const server = await startServer(fixture);
    await createCompanies(server, [COMPANY_A, COMPANY_B]);
    const db = openFixtureDb(fixture);
    const day = utcDay();
    const shared = '+7 555 030-00-03';
    const movedContact = '+7 555 030-00-33';
    const personal = [shared, '75550300003', movedContact, '75550300033', 'Синтетика A', 'Синтетика B',
      'Синтетика legacy', 'Синтетика перенос'];

    const leadA = await postLead(server, {name: personal[4], contact: shared, companyCode: COMPANY_A.code}, ORIGIN_A);
    const leadB = await postLead(server, {name: personal[5], contact: shared, companyCode: COMPANY_B.code}, ORIGIN_B);
    const legacy = await postLead(server, {name: personal[6], contact: shared});
    for (const response of [leadA, leadB, legacy]) assert.equal(response.status, 201);
    assert.equal(new Set([leadA.body.id, leadB.body.id, legacy.body.id]).size, 3, 'один контакт не склеивает компании');
    assert.equal(legacy.body.companyCode, null);

    const repeatB = await postLead(server, {contact: shared, companyCode: COMPANY_B.code}, ORIGIN_B);
    const repeatA = await postLead(server, {contact: shared, companyCode: 'RECEIPT_A'}, ORIGIN_A);
    const repeatLegacy = await postLead(server, {contact: shared});
    for (const [response, lead] of [[repeatB, leadB], [repeatA, leadA], [repeatLegacy, legacy]]) {
      assert.equal(response.status, 200);
      assert.equal(response.body.deduplicated, true);
      assert.equal(response.body.id, lead.body.id);
    }
    for (const [lead, companyCode] of [[leadA, COMPANY_A.code], [leadB, COMPANY_B.code], [legacy, null]]) {
      const rows = receiptsFor(db, lead.body.id);
      assert.deepEqual(rows.map((row) => row.company_code), [companyCode, companyCode]);
      assert.deepEqual(rows.map((row) => row.outcome), ['created', 'deduplicated']);
    }
    assert.deepEqual(receiptsFor(db, legacy.body.id).map((row) => row.origin_state), ['unknown', 'unknown']);

    // Перенос CRM-строки в B не переписывает уже принятый receipt A.
    const moved = await postLead(server, {name: personal[7], contact: movedContact, companyCode: COMPANY_A.code}, ORIGIN_A);
    assert.equal(moved.status, 201);
    const createdReceipt = receiptsFor(db, moved.body.id)[0];
    const patched = await request(server, 'PATCH', `/leads/${moved.body.id}`,
      {body: {companyCode: COMPANY_B.code}, api: true});
    assert.equal(patched.status, 200);
    assert.equal(patched.body.companyCode, COMPANY_B.code);
    const movedRepeat = await postLead(server, {contact: movedContact, companyCode: COMPANY_B.code}, ORIGIN_B);
    assert.equal(movedRepeat.status, 200);
    assert.equal(movedRepeat.body.id, moved.body.id);
    const movedReceipts = receiptsFor(db, moved.body.id);
    assert.deepEqual(movedReceipts[0], createdReceipt, 'исходный receipt неизменен');
    assert.deepEqual(movedReceipts.map((row) => row.company_code), [COMPANY_A.code, COMPANY_B.code]);
    assert.deepEqual(movedReceipts.map((row) => row.outcome), ['created', 'deduplicated']);
    assertNoValues(allReceipts(db), personal, 'revenue_lead_receipts');

    const reportA = await journalReport(server, COMPANY_A.code, day);
    const reportB = await journalReport(server, COMPANY_B.code, day);
    // legacyLeadRowsCount — изменяемый CRM-факт по текущей company_code, отдельно от receipts.
    assertAttemptJournal(t, reportA, {
      companyCode: COMPANY_A.code, day, counts: {total: 3, created: 2, deduplicated: 1}, legacyLeadRows: 1,
    });
    assertAttemptJournal(t, reportB, {
      companyCode: COMPANY_B.code, day, counts: {total: 3, created: 1, deduplicated: 2}, legacyLeadRows: 2,
    });
    assertNoValues(reportA, personal, 'revenue-analytics A');
    assertNoValues(reportB, personal, 'revenue-analytics B');
  });
});

test('STRICT_ORIGIN отклоняет до CRM и receipt; permissive фиксирует mismatch/missing, matched только для своего домена', async () => {
  await withFixture(async (fixture) => {
    const server = await startServer(fixture, {strict: true});
    await createCompanies(server, [COMPANY_A, COMPANY_B]);
    const db = openFixtureDb(fixture);
    const rejectedHeaders = [{Origin: 'https://evil.test'}, {}, ORIGIN_B, {Referer: 'https://receipt-b.test/form'}];
    for (const [index, headers] of rejectedHeaders.entries()) {
      const rejected = await postLead(server, {
        name: 'Синтетика strict', contact: `+7 555 040-00-0${index}`, companyCode: COMPANY_A.code,
      }, headers);
      assert.equal(rejected.status, 403);
      assert.equal(rejected.body.details.code, 'ORIGIN_MISMATCH');
    }
    assert.deepEqual(tableCounts(db), {leads: 0, stage_history: 0, lead_email_outbox: 0, revenue_lead_receipts: 0});

    const matched = await postLead(server, {
      name: 'Синтетика strict', contact: '+7 555 040-00-10', companyCode: COMPANY_A.code,
    }, {Origin: 'https://www.receipt-a.test'});
    assert.equal(matched.status, 201);
    // Без компании домен не проверяется и раньше: новых запретов для legacy-форм нет.
    const legacy = await postLead(server, {name: 'Синтетика strict', contact: '+7 555 040-00-11'},
      {Origin: 'https://evil.test'});
    assert.equal(legacy.status, 201);
    assert.deepEqual(pick(receiptsFor(db, matched.body.id)[0], ['company_code', 'origin_state', 'trust']),
      {company_code: COMPANY_A.code, origin_state: 'matched', trust: 'declared_public'});
    assert.deepEqual(pick(receiptsFor(db, legacy.body.id)[0], ['company_code', 'origin_state']),
      {company_code: null, origin_state: 'unknown'});
  });

  await withFixture(async (fixture) => {
    const server = await startServer(fixture);
    await createCompanies(server, [COMPANY_A, COMPANY_B]);
    const db = openFixtureDb(fixture);
    const cases = [
      [COMPANY_A.code, {Origin: 'https://evil.test'}, 'mismatch'],
      [COMPANY_A.code, {}, 'missing'],
      [COMPANY_A.code, ORIGIN_B, 'mismatch'],
      [COMPANY_A.code, {Referer: 'https://receipt-a.test/form'}, 'matched'],
      [COMPANY_A.code, {Origin: 'https://www.receipt-a.test'}, 'matched'],
      [COMPANY_B.code, ORIGIN_A, 'mismatch'],
      [COMPANY_B.code, ORIGIN_B, 'matched'],
    ];
    const leads = [];
    for (const [index, [companyCode, headers, originState]] of cases.entries()) {
      const response = await postLead(server, {
        name: 'Синтетика origin', contact: `+7 555 041-00-${String(index).padStart(2, '0')}`, companyCode,
      }, headers);
      assert.equal(response.status, 201, `случай ${index}`);
      leads.push(response.body.id);
      // Совпадение домена не делает заявку проверенным человеком или авторизованным запросом.
      assert.deepEqual(pick(receiptsFor(db, response.body.id)[0], ['company_code', 'origin_state', 'trust']),
        {company_code: companyCode, origin_state: originState, trust: 'declared_public'}, `случай ${index}`);
    }
    // Состояние домена относится к каждой попытке отдельно.
    const repeated = await postLead(server, {contact: '+7 555 041-00-00', companyCode: COMPANY_A.code}, ORIGIN_A);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.id, leads[0]);
    assert.deepEqual(receiptsFor(db, leads[0]).map((row) => row.origin_state), ['mismatch', 'matched']);
  });
});

test('ошибка receipt в BEGIN IMMEDIATE откатывает заявку, этап, outbox и receipt; затем приём восстанавливается', async () => {
  await withFixture(async (fixture) => {
    const server = await startServer(fixture);
    await createCompanies(server, [COMPANY_A]);
    const db = openFixtureDb(fixture);
    const base = await postLead(server, {
      name: 'Синтетика откат', contact: '+7 555 050-00-01', companyCode: COMPANY_A.code,
    }, ORIGIN_A);
    assert.equal(base.status, 201);
    // email-outbox.enqueue вставляет строку при каждой новой заявке независимо от SMTP.
    assert.equal(countWhere(db, 'SELECT COUNT(*) AS count FROM lead_email_outbox WHERE lead_id = ?', base.body.id), 1);
    const before = tableCounts(db);

    const trigger = `test_lead_intake_abort_${randomBytes(6).toString('hex')}`;
    const entry = {db, name: trigger};
    db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON revenue_lead_receipts
      BEGIN SELECT RAISE(ABORT, 'test-only receipt abort'); END`);
    fixture.triggers.add(entry);
    try {
      const failedCreate = await postLead(server, {
        name: 'Синтетика откат', contact: '+7 555 050-00-02', companyCode: COMPANY_A.code,
      }, ORIGIN_A);
      assert.equal(failedCreate.status, 500);
      assert.equal(failedCreate.body.details, undefined);
      assert.deepEqual(tableCounts(db), before);
      assert.equal(countWhere(db, 'SELECT COUNT(*) AS count FROM leads WHERE normalized_contact = ?', '75550500002'), 0);

      const outboxBefore = db.prepare('SELECT next_attempt_at FROM lead_email_outbox WHERE lead_id = ?')
        .get(base.body.id).next_attempt_at;
      const duplicateStarted = new Date().toISOString();
      const failedDuplicate = await postLead(server, {contact: '+7 555 050-00-01', companyCode: COMPANY_A.code}, ORIGIN_A);
      const duplicateFinished = new Date().toISOString();
      assert.equal(failedDuplicate.status, 500);
      assert.deepEqual(tableCounts(db), before);
      assert.equal(receiptsFor(db, base.body.id).length, 1);
      // Откаченный wake не оставляет next_attempt_at из окна запроса; фоновые повторы ставят время только в будущее.
      const outboxAfter = db.prepare('SELECT next_attempt_at FROM lead_email_outbox WHERE lead_id = ?')
        .get(base.body.id).next_attempt_at;
      assert.ok(outboxAfter === outboxBefore || outboxAfter < duplicateStarted || outboxAfter > duplicateFinished,
        'wake дубликата не должен сохраниться после ROLLBACK');
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      fixture.triggers.delete(entry);
    }
    assert.equal(countWhere(db, "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      trigger), 0);
    assert.equal(countWhere(db, `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN
      ('revenue_lead_receipts_no_replace', 'revenue_lead_receipts_no_update', 'revenue_lead_receipts_no_delete')`), 3);

    const recovered = await postLead(server, {
      name: 'Синтетика откат', contact: '+7 555 050-00-02', companyCode: COMPANY_A.code,
    }, ORIGIN_A);
    assert.equal(recovered.status, 201);
    const repeated = await postLead(server, {contact: '+7 555 050-00-01', companyCode: COMPANY_A.code}, ORIGIN_A);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.deduplicated, true);
    assert.equal(repeated.body.id, base.body.id);
    assert.deepEqual(tableCounts(db), {
      leads: before.leads + 1, stage_history: before.stage_history + 1,
      lead_email_outbox: before.lead_email_outbox + 1, revenue_lead_receipts: before.revenue_lead_receipts + 2,
    });
    assert.deepEqual(receiptsFor(db, recovered.body.id).map((row) => row.outcome), ['created']);
    assert.deepEqual(receiptsFor(db, base.body.id).map((row) => row.outcome), ['created', 'deduplicated']);
  });
});

test('перезапуск той же БД: новая сессия писателя, прежняя активация неизменна, разрыв не покрыт', async (t) => {
  await withFixture(async (fixture) => {
    const day = utcDay();
    const first = await startServer(fixture);
    await createCompanies(first, [COMPANY_A]);
    const contact = '+7 555 060-00-01';
    const created = await postLead(first, {name: 'Синтетика рестарт', contact, companyCode: COMPANY_A.code}, ORIGIN_A);
    assert.equal(created.status, 201);
    const db = openFixtureDb(fixture);
    const activation = plain(db.prepare('SELECT * FROM revenue_lead_receipt_writer').get());
    assert.equal(activation.version, 'lead-receipts/v1');
    const firstStarts = writerStarts(db);
    assert.equal(firstStarts.length, 1, 'запуск 1 сохранил start');
    assert.equal(activation.activated_ms, firstStarts[0].occurred_ms);
    const firstSession = firstStarts[0].session_id;
    const receiptMs = receiptsFor(db, created.body.id)[0].received_ms;

    const exit = await stopServer(first);
    assert.ok(exit, 'первый server.js завершился');
    const closes = db.prepare(
      "SELECT occurred_ms FROM revenue_lead_writer_events WHERE session_id = ? AND kind = 'close'"
    ).all(firstSession).map(plain);
    await t.test('штатная остановка завершает сессию close до db.close (Windows fixture IPC / Unix SIGTERM)', () => {
      assert.equal(first.forced, false, 'остановка не потребовала SIGKILL');
      assert.deepEqual(exit, {code: 0, signal: null});
      assert.equal(closes.length, 1);
      assert.ok(closes[0].occurred_ms >= receiptMs);
    });
    const firstLastMs = Number(db.prepare(
      'SELECT MAX(occurred_ms) AS ms FROM revenue_lead_writer_events WHERE session_id = ?'
    ).get(firstSession).ms);

    await sleep(25);
    const second = await startServer(fixture);
    const starts = writerStarts(db);
    assert.equal(starts.length, 2, 'запуск 2 создал новую сессию');
    assert.equal(starts[0].session_id, firstSession);
    assert.notEqual(starts[1].session_id, firstSession);
    assert.ok(starts[1].occurred_ms - firstLastMs >= 20, 'между сессиями есть положительный разрыв');
    assert.deepEqual(plain(db.prepare('SELECT * FROM revenue_lead_receipt_writer').get()), activation);
    assert.equal(countWhere(db,
      'SELECT COUNT(*) AS count FROM revenue_lead_writer_events WHERE session_id = ? AND occurred_ms > ?',
      firstSession, firstLastMs), 0, 'новый запуск не продлевает прежнюю сессию');

    const repeated = await postLead(second, {contact, companyCode: COMPANY_A.code}, ORIGIN_A);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.id, created.body.id);
    const report = await journalReport(second, COMPANY_A.code, day);
    const journal = assertAttemptJournal(t, report, {
      companyCode: COMPANY_A.code, day, counts: {total: 2, created: 1, deduplicated: 1}, legacyLeadRows: 1,
    });
    assert.equal(journal.writer.since, activation.activated_at);
    if (utcDay() === day) assert.ok(journal.reasons.includes('writer_coverage_gap'), 'разрыв перезапуска не покрыт');
  });
});
