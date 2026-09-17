'use strict';

/* Подделки для офлайн-тестов worker: управляемые часы, сценарный транспорт,
   рантайм с настраиваемым ответом. Настоящие SQLite job-store и outbox — во временном каталоге. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createJobStore} = require('../../hugh-runtime/job-store');
const {createOutbox} = require('../outbox');
const {TransportError} = require('../transport');
const {LocalHughWorker} = require('../worker');

const START_TIME = Date.parse('2026-09-17T10:00:00.000Z');

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/* Часы с таймерами: advance(ms) выполняет все таймеры, срок которых наступил, по порядку. */
class FakeClock {
  constructor(start = START_TIME) {
    this.time = start;
    this.timers = new Map();
    this.seq = 0;
    this.now = () => this.time;
    this.setTimeout = (fn, ms) => {
      this.seq += 1;
      this.timers.set(this.seq, {id: this.seq, at: this.time + Math.max(0, Number(ms) || 0), fn});
      return this.seq;
    };
    this.clearTimeout = (id) => {
      this.timers.delete(id);
    };
  }

  async advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.values()].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers.delete(due.id);
      this.time = Math.max(this.time, due.at);
      due.fn();
      await flush();
    }
    this.time = target;
    await flush();
  }

  pendingTimers() {
    return this.timers.size;
  }
}

/* Транспорт по сценарию: on(operation, handler). handler(body, callIndex) возвращает
   {status, body} либо бросает TransportError. Все вызовы записываются. */
class FakeTransport {
  constructor() {
    this.calls = [];
    this.handlers = new Map();
    this.secure = true;
  }

  on(operation, handler) {
    this.handlers.set(operation, handler);
    return this;
  }

  callsFor(operation) {
    return this.calls.filter((call) => call.operation === operation);
  }

  async post(operation, body) {
    const snapshot = JSON.parse(JSON.stringify(body));
    this.calls.push({operation, body: snapshot});
    const handler = this.handlers.get(operation);
    if (!handler) return {status: 200, body: {ok: true}};
    const result = await handler(snapshot, this.callsFor(operation).length);
    if (result instanceof Error) throw result;
    return result;
  }
}

const networkError = () => new TransportError('network');

const DEFAULT_SNAPSHOT = Object.freeze({
  connected: true,
  authenticated: true,
  available: true,
  limited: false,
  retryAfter: null,
  limitedUntil: null,
  limitReason: null,
  provider: 'codex',
  model: 'gpt-5.5',
  state: 'connected',
  loginUrl: null,
  userCode: null,
  error: null,
  errorCode: null,
  replyEnabled: true,
  version: '0.154.0',
  safety: {toolIsolationVerified: true, reason: 'proof_ok'},
});

const idleLogin = () => ({status: 'idle', loginId: null, verificationUrl: null, userCode: null, expiresAt: null, reason: null});

class FakeRuntime {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.snapshot = {...DEFAULT_SNAPSHOT, ...(options.snapshot || {})};
    this.replyImpl = options.reply || (async () => ({text: 'Готово.', model: 'gpt-5.5'}));
    this.loginImpl = options.startLogin || null;
    this.replyCalls = [];
    this.login = idleLogin();
    this.client = {running: options.clientRunning !== false};
    this.authenticated = options.authenticated !== false;
    this.preflight = {ok: true, reason: 'environments_empty', model: 'gpt-5.5'};
    this.warmUps = 0;
    this.refreshes = 0;
    this.preflights = 0;
  }

  statusSnapshot() {
    const pending = this.login.status === 'pending';
    return {
      ...this.snapshot,
      loginUrl: pending ? this.login.verificationUrl : null,
      userCode: pending ? this.login.userCode : null,
      error: this.snapshot.errorCode ? 'Текст ошибки, который не должен уйти наружу' : null,
    };
  }

  async reply(payload) {
    this.replyCalls.push(payload);
    return this.replyImpl(payload, this.replyCalls.length);
  }

  async startLogin() {
    if (this.loginImpl) return this.loginImpl();
    this.login = {
      status: 'pending',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: this.now() + 15 * 60 * 1000,
      reason: null,
    };
    return this.statusSnapshot();
  }

  async warmUp() {
    this.warmUps += 1;
    this.client = {running: true};
    return null;
  }

  async refreshAccount() {
    this.refreshes += 1;
    return this.authenticated;
  }

  async runPreflight() {
    this.preflights += 1;
    this.preflight = {ok: true, reason: 'environments_empty', model: 'gpt-5.5'};
    return this.preflight;
  }

  async stop() {
    return null;
  }
}

const silentLogger = {log() {}, info() {}, warn() {}, error() {}};

/* Журнал-накопитель: тесты проверяют, что в строках нет секретов. */
function recordingLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${String(message)}`);
  return {lines, log: push('info'), info: push('info'), warn: push('warn'), error: push('error')};
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function replyPayload(overrides = {}) {
  return {
    jobId: 'project-chat:42',
    companyCode: 'palitra-love',
    system: 'Ты Хью, отвечай кратко.',
    messages: [{role: 'user', content: 'Когда вы работаете?'}],
    ...overrides,
  };
}

/* Задание в том виде, в каком его отдаёт claim. payloadHash — SHA256 сохранённой строки. */
function claimedJob(options = {}) {
  const payload = options.payload === undefined ? replyPayload() : options.payload;
  const stored = JSON.stringify(payload);
  const now = options.now || START_TIME;
  return {
    id: options.id || '42',
    kind: options.kind || 'reply',
    companyCode: options.companyCode || 'palitra-love',
    payload,
    payloadHash: options.payloadHash || sha256(stored),
    leaseToken: options.leaseToken || 'lease-token-0001',
    leaseExpiresAt: options.leaseExpiresAt || new Date(now + 180_000).toISOString(),
  };
}

function tempDir(prefix = 'local-hugh-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function removeDir(directory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/* Собирает worker с подделками и настоящими SQLite. dir можно передать для «перезапуска». */
function createHarness(options = {}) {
  const dir = options.dir || tempDir();
  const clock = options.clock || new FakeClock();
  const transport = options.transport || new FakeTransport();
  const runtime = options.runtime || new FakeRuntime({now: clock.now, ...(options.runtimeOptions || {})});
  const store = createJobStore(path.join(dir, 'state.sqlite'), {now: clock.now, leaseMs: 180_000});
  const outbox = createOutbox(path.join(dir, 'outbox.sqlite'), {now: clock.now});
  const logger = options.logger || recordingLogger();
  const statusDocs = [];
  const worker = new LocalHughWorker({
    runtime,
    store,
    outbox,
    transport,
    logger,
    scheduler: clock,
    bootId: options.bootId || 'boot-0001',
    companies: options.companies || ['palitra-love'],
    statusWriter: options.statusWriter === null ? null : (doc) => statusDocs.push(doc),
    settings: options.settings || {},
  });
  return {
    dir,
    clock,
    transport,
    runtime,
    store,
    outbox,
    logger,
    worker,
    statusDocs,
    lastStatus: () => statusDocs[statusDocs.length - 1] || null,
    async cleanup(keepDir = false) {
      // stop() честно ждёт текущую генерацию; в тесте с «вечным» ответом уборка не должна зависнуть.
      await Promise.race([worker.stop(), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      try {
        store.close();
      } catch {
        /* уже закрыт */
      }
      try {
        outbox.close();
      } catch {
        /* уже закрыт */
      }
      if (!keepDir) await removeDir(dir);
    },
  };
}

module.exports = {
  START_TIME,
  FakeClock,
  FakeTransport,
  FakeRuntime,
  networkError,
  silentLogger,
  recordingLogger,
  sha256,
  replyPayload,
  claimedJob,
  tempDir,
  removeDir,
  createHarness,
  flush,
};
