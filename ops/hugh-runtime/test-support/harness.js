'use strict';

/* Общая обвязка тестов: временные каталоги, сценарии поддельного app-server,
   готовый экземпляр HughRuntime и доказательство изоляции для открытия предохранителя. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {AppServerClient} = require('../app-server-client');
const {HughRuntime} = require('../runtime');
const {createJobStore} = require('../job-store');
const {isolationFingerprint, PINNED_CODEX_VERSION} = require('../codex-config');
const {buildProof} = require('../safety-gate');

const FAKE_APP_SERVER = path.join(__dirname, 'fake-app-server.js');
const USER_AGENT = `codex_cli_rs/${PINNED_CODEX_VERSION} (Linux 6.1.0; x86_64) test`;

function tempDir(prefix = 'hugh-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* Уборка временного каталога с проверкой пути и ограниченными повторами.
   На Windows дескрипторы освобождаются не мгновенно даже после выхода процесса. */
async function removeDir(directory) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const resolved = normalize(fs.realpathSync.native(path.dirname(path.resolve(directory))));
  const tmpRoot = normalize(fs.realpathSync.native(os.tmpdir()));
  if (!resolved.startsWith(tmpRoot)) {
    throw new Error(`уборка разрешена только внутри ${tmpRoot}, получено ${directory}`);
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 50});
      return;
    } catch (error) {
      if (attempt === 11) {
        // Не роняем тест из-за уборки: сам каталог временный.
        process.emitWarning(`не удалось убрать ${directory}: ${error.code}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function chatgptAccount() {
  return {account: {type: 'chatgpt', email: 'owner@example.com', planType: 'pro'}, requiresOpenaiAuth: true};
}

function threadStartResult(environments = [], model = 'gpt-test') {
  return {
    thread: {
      id: 'thread-1',
      environments,
      sessionId: 'session-1',
      ephemeral: true,
      preview: '',
      modelProvider: 'openai',
      model,
      projectId: null,
      cwd: '/workspace',
      status: 'idle',
      cliVersion: PINNED_CODEX_VERSION,
      createdAt: 0,
      updatedAt: 0,
    },
    model,
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/workspace',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: {mode: 'read-only'},
    reasoningEffort: null,
  };
}

/* phase соответствует MessagePhase: 'final_answer' | 'commentary' | null (фаза неизвестна). */
function agentMessage(text, id = 'item-1', phase = 'final_answer') {
  return {
    method: 'item/completed',
    params: {
      threadId: '__THREAD_ID__',
      turnId: 'turn-1',
      item: {type: 'agentMessage', id, text, phase},
    },
  };
}

function turnCompleted(status = 'completed', error = null) {
  return {
    method: 'turn/completed',
    params: {
      threadId: '__THREAD_ID__',
      turn: {id: 'turn-1', items: [], itemsView: 'full', status, error, startedAt: 0, completedAt: 1, durationMs: 10},
    },
  };
}

/* Сценарий «всё хорошо»: подписка на месте, окружения пустые, один ответ модели. */
function happyScenario(options = {}) {
  return {
    methods: {
      initialize: {result: {userAgent: options.userAgent || USER_AGENT, codexHome: '/data/codex', platformFamily: 'unix', platformOs: 'linux'}},
      'account/read': {result: options.account || chatgptAccount()},
      'thread/start': {result: threadStartResult(options.environments || [], options.threadModel || 'gpt-test')},
      'turn/start': {
        result: {turn: {id: 'turn-1', items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 0, completedAt: null, durationMs: null}},
        after: options.after || [agentMessage(options.replyText || 'Готово.'), turnCompleted()],
        afterDelayMs: options.afterDelayMs ?? 2,
        serverRequests: options.serverRequests || [],
        emitOrder: options.emitOrder || 'requestsFirst',
      },
      'turn/interrupt': {result: {}},
      'account/login/start': options.loginStart || {result: {type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234'}},
      'account/login/cancel': {result: {status: 'canceled'}},
    },
    ...(options.extra || {}),
  };
}

function writeScenario(directory, scenario) {
  const file = path.join(directory, `scenario-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(scenario));
  return file;
}

/* Каждому запуску процесса можно дать свой сценарий: так проверяется восстановление
   после перезапуска app-server. Последний сценарий используется для всех дальнейших запусков. */
function fakeClientFactory({scenarioPaths, recordPath, captured, clients}) {
  let started = 0;
  return (config) => {
    const scenarioPath = scenarioPaths[Math.min(started, scenarioPaths.length - 1)];
    started += 1;
    if (captured) captured.push(config);
    const client = new AppServerClient({
      executable: process.execPath,
      args: [FAKE_APP_SERVER],
      cwd: config.cwd,
      env: {
        ...config.env,
        HUGH_FAKE_SCENARIO: scenarioPath,
        ...(recordPath ? {HUGH_FAKE_RECORD: recordPath} : {}),
      },
      requestTimeoutMs: 5000,
    });
    // Ссылки сохраняются, чтобы тесты могли проверить, что прежний процесс закрыт.
    if (clients) clients.push(client);
    return client;
  };
}

function writeProof(proofPath, overrides = {}) {
  const proof = {
    ...buildProof({
      fingerprint: isolationFingerprint({modelCatalogSha256: null, model: null}),
      codexVersion: PINNED_CODEX_VERSION,
      observedTools: [],
      injectedToolCallsExecuted: false,
      canaryIntact: true,
    }),
    ...overrides,
  };
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  return proof;
}

const silentLogger = {log() {}, warn() {}, error() {}};

/* Возвращает {runtime, store, dir, recordPath, captured, cleanup}. */
function createRuntime(options = {}) {
  const dir = tempDir();
  const codexHome = path.join(dir, 'codex');
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, {recursive: true});
  const proofPath = path.join(dir, 'proof.json');
  // options.scenarios — по сценарию на каждый запуск процесса, options.scenario — один на все.
  const scenarios = options.scenarios || [options.scenario || happyScenario()];
  const scenarioPaths = scenarios.map((scenario) => writeScenario(dir, scenario));
  const recordPath = path.join(dir, 'received.jsonl');
  const captured = [];
  const clients = [];
  const store = createJobStore(path.join(dir, 'state.sqlite'));
  const runtime = new HughRuntime({
    executable: '/usr/local/bin/codex',
    codexHome,
    workspace,
    proofPath,
    store,
    logger: options.logger || silentLogger,
    jobTimeoutMs: options.jobTimeoutMs || 4000,
    loginTimeoutMs: options.loginTimeoutMs || 60_000,
    // Поддельный app-server не читает каталог; отдельный тест проверяет требование прода.
    requireCatalog: false,
    clientFactory: fakeClientFactory({scenarioPaths, recordPath, captured, clients}),
    ...options.runtimeOptions,
  });
  runtime.prepare();
  // Доказательство пишется под фактический отпечаток рантайма: он зависит от каталога и слага.
  if (options.verified !== false) {
    writeProof(proofPath, {fingerprint: runtime.fingerprint, ...options.proofOverrides});
    runtime.reloadGate();
  }
  return {
    runtime,
    store,
    dir,
    proofPath,
    recordPath,
    captured,
    clients,
    received: () =>
      fs
        .readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    /* Обязательно await: без ожидания выхода процесса Windows отдаёт EPERM на rm. */
    async cleanup() {
      await runtime.stop();
      try {
        store.close();
      } catch {
        /* уже закрыт */
      }
      await removeDir(dir);
    },
  };
}

module.exports = {
  FAKE_APP_SERVER,
  USER_AGENT,
  tempDir,
  removeDir,
  chatgptAccount,
  threadStartResult,
  agentMessage,
  turnCompleted,
  happyScenario,
  writeScenario,
  fakeClientFactory,
  writeProof,
  createRuntime,
  silentLogger,
};
