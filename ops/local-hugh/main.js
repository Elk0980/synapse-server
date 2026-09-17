'use strict';

/* Точка входа локального обработчика Хью на Windows.

   node main.js [путь к config.json]
   По умолчанию: %SYNAPSE_HUGH_CONFIG% либо %LOCALAPPDATA%\SynapseHugh\config.json.

   Входящих портов нет. Ключ читается из keyFile и передаётся только транспорту;
   в окружение дочернего Codex он не попадает (runtime.childEnv собирает белый список сам).
   Код выхода 0 — штатная остановка или уже запущенный экземпляр; 1 — ошибка конфигурации
   или фатальный сбой (планировщик перезапустит задачу). */

const fs = require('node:fs');
const path = require('node:path');
const {HughRuntime} = require('../hugh-runtime/runtime');
const {createJobStore} = require('../hugh-runtime/job-store');
const {PINNED_CODEX_VERSION} = require('../hugh-runtime/codex-config');
const {loadConfig, ConfigError} = require('./worker-config');
const {createTransport, EndpointError} = require('./transport');
const {createOutbox} = require('./outbox');
const {createStatusWriter} = require('./status-file');
const {createLogger} = require('./logger');
const {LocalHughWorker, WORKER_VERSION} = require('./worker');

function defaultConfigPath() {
  if (process.env.SYNAPSE_HUGH_CONFIG) return process.env.SYNAPSE_HUGH_CONFIG;
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local');
  return path.join(local, 'SynapseHugh', 'config.json');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/* Один экземпляр на машину: файл-замок с PID. Устаревший замок мёртвого процесса снимается. */
function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), {recursive: true});
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let pid = NaN;
      try {
        pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
      } catch {
        pid = NaN;
      }
      if (pidAlive(pid) && pid !== process.pid) return false;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* повтор ниже покажет, свободен ли замок */
      }
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (pid === process.pid) fs.unlinkSync(lockPath);
  } catch {
    /* замка уже нет */
  }
}

async function main() {
  const configPath = process.argv[2] || defaultConfigPath();
  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (error) {
    const code = error instanceof ConfigError || error instanceof EndpointError ? error.code || error.reason : 'config_error';
    process.stderr.write(`local-hugh: config_invalid code=${JSON.stringify(code)}\n`);
    process.exit(1);
    return;
  }
  const {settings, token} = loaded;
  const logger = createLogger({path: settings.logPath, mirror: process.stdout.isTTY ? console : null});

  if (!acquireLock(settings.lockPath)) {
    logger.warn('local-hugh: instance_already_running');
    process.exit(0);
    return;
  }

  for (const directory of [settings.codexHome, settings.workspace, path.dirname(settings.statePath), path.dirname(settings.outboxPath), path.dirname(settings.statusPath)]) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  }
  if (!fs.existsSync(settings.codexBinary)) {
    logger.error('local-hugh: codex_binary_missing');
    releaseLock(settings.lockPath);
    process.exit(1);
    return;
  }

  let transport;
  try {
    transport = createTransport({endpoint: settings.endpoint, token, allowInsecureLoopback: settings.allowInsecureLoopback});
  } catch (error) {
    logger.error(`local-hugh: transport_invalid code=${JSON.stringify((error && error.reason) || 'error')}`);
    releaseLock(settings.lockPath);
    process.exit(1);
    return;
  }

  // Аренда job-store короче, чем у сервера: прерванная генерация становится повторяемой
  // без ожидания 10 минут; при восстановлении активное задание снимается явно.
  const store = createJobStore(settings.statePath, {leaseMs: settings.jobTimeoutMs + 60_000, retentionHours: 72});
  const outbox = createOutbox(settings.outboxPath);
  const runtime = new HughRuntime({
    executable: settings.codexBinary,
    codexHome: settings.codexHome,
    workspace: settings.workspace,
    model: settings.model,
    proofPath: settings.proofPath,
    modelCatalogPath: settings.catalogPath,
    jobTimeoutMs: settings.jobTimeoutMs,
    store,
    logger,
  });
  runtime.prepare();
  if (!runtime.catalogState.ok) logger.error(`local-hugh: catalog_rejected reason=${JSON.stringify(runtime.catalogState.reason)}`);
  if (!runtime.gate.verified) logger.warn(`local-hugh: gate_closed reason=${JSON.stringify(runtime.gate.reason)}`);
  runtime.warmUp();

  const worker = new LocalHughWorker({
    runtime,
    store,
    outbox,
    transport,
    logger,
    companies: settings.companies,
    statusWriter: createStatusWriter(settings.statusPath),
    settings: {heartbeatIntervalMs: settings.heartbeatIntervalMs, renewIntervalMs: settings.renewIntervalMs},
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.log(`local-hugh: shutdown signal=${JSON.stringify(signal)}`);
    try {
      await worker.stop();
      await runtime.stop();
    } finally {
      try {
        store.close();
        outbox.close();
      } catch {
        /* уже закрыты */
      }
      releaseLock(settings.lockPath);
      process.exit(0);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => shutdown(signal));
    } catch {
      /* сигнал недоступен на этой платформе */
    }
  }
  process.on('uncaughtException', (error) => {
    logger.error(`local-hugh: uncaught name=${JSON.stringify((error && error.name) || 'Error')}`);
    releaseLock(settings.lockPath);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    logger.error(`local-hugh: unhandled name=${JSON.stringify((error && error.name) || 'Error')}`);
  });

  logger.log(`local-hugh: started version=${WORKER_VERSION} codex=${PINNED_CODEX_VERSION} companies=${JSON.stringify(settings.companies)}`);
  await worker.start();
}

main().catch((error) => {
  process.stderr.write(`local-hugh: fatal name=${JSON.stringify((error && error.name) || 'Error')}\n`);
  process.exit(1);
});
