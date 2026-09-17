'use strict';

/* Synapse Business — приватный рантайм Hugh на подписке ChatGPT.
   Держит один процесс `codex app-server` с отдельным CODEX_HOME и отвечает
   сервисам chat и content по внутреннему HTTP. Внешних пакетов нет: Node 24. */

const path = require('node:path');
const {HughRuntime} = require('./runtime');
const {createJobStore} = require('./job-store');
const {createHttpServer} = require('./http-server');
const {PINNED_CODEX_VERSION} = require('./codex-config');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const API_KEY = (process.env.CHAT_API_KEY || '').trim();
const CODEX_HOME = process.env.CODEX_HOME || '/data/codex';
const WORKSPACE = process.env.HUGH_WORKSPACE || '/workspace';
const CODEX_BINARY = process.env.HUGH_CODEX_BINARY || '/usr/local/bin/codex';
const DATABASE_PATH = process.env.DATABASE_PATH || '/data/state/hugh-runtime.sqlite';
// Каталог и доказательство изоляции создаются при сборке образа и лежат в /app/build.
const PROOF_PATH = process.env.HUGH_PROOF_PATH || '/app/build/tool-isolation-proof.json';
const MODEL_CATALOG_PATH = (process.env.HUGH_MODEL_CATALOG_PATH || '').trim() || '/app/build/restricted-models.json';
const MODEL = (process.env.HUGH_MODEL || '').trim() || null;
const JOB_TIMEOUT_MS = Number.parseInt(process.env.HUGH_JOB_TIMEOUT_MS || '120000', 10);
const RETENTION_HOURS = Number.parseInt(process.env.HUGH_JOB_RETENTION_HOURS || '72', 10);
const INTERRUPT_GRACE_MS = Number.parseInt(process.env.HUGH_INTERRUPT_GRACE_MS || '15000', 10);

if (!API_KEY) {
  console.error('hugh-runtime: CHAT_API_KEY пуст — запуск отменён');
  process.exit(1);
}
if (!path.isAbsolute(CODEX_BINARY)) {
  console.error('hugh-runtime: HUGH_CODEX_BINARY должен быть абсолютным путём');
  process.exit(1);
}

require('node:fs').mkdirSync(path.dirname(DATABASE_PATH), {recursive: true, mode: 0o700});

const store = createJobStore(DATABASE_PATH, {retentionHours: RETENTION_HOURS});
const runtime = new HughRuntime({
  executable: CODEX_BINARY,
  codexHome: CODEX_HOME,
  workspace: WORKSPACE,
  model: MODEL,
  proofPath: PROOF_PATH,
  modelCatalogPath: MODEL_CATALOG_PATH,
  jobTimeoutMs: JOB_TIMEOUT_MS,
  interruptGraceMs: INTERRUPT_GRACE_MS,
  store,
});

runtime.prepare();
if (!runtime.catalogState.ok) {
  console.error(
    `hugh-runtime: каталог моделей отклонён reason=${JSON.stringify(runtime.catalogState.reason)} —` +
      ' /reply отвечает 503 MODEL_CATALOG_REJECTED',
  );
}
if (!runtime.gate.verified) {
  console.warn(
    `hugh-runtime: предохранитель закрыт reason=${JSON.stringify(runtime.gate.reason)} —` +
      ' /reply отвечает 503 TOOL_ISOLATION_UNVERIFIED до подтверждения изоляции',
  );
}

runtime.warmUp();

const server = createHttpServer({runtime, store, apiKey: API_KEY});
server.listen(PORT, () => {
  console.log(`hugh-runtime: порт ${PORT}, закреплённый Codex ${PINNED_CODEX_VERSION}, CODEX_HOME ${CODEX_HOME}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => {
      await runtime.stop();
      store.close();
      process.exit(0);
    });
  });
}
