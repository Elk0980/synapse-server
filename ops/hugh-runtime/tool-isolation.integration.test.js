'use strict';

/* Локальный прогон проверки изоляции на настоящем закреплённом бинаре Codex 0.154.0.
   Подписка, платный вывод и выход в интернет не нужны: провайдер поддельный, на loopback.

   Запуск владельцем:
     set CODEX_TEST_BINARY=C:\\...\\codex.exe
     node --test ops/hugh-runtime/tool-isolation.integration.test.js

   Каталог моделей собирается здесь же из официального встроенного набора того же бинаря
   (`codex debug models --bundled`), поэтому локальная проверка использует ровно ту же
   конфигурацию, тот же каталог и тот же отпечаток, что и сборка образа.

   Без CODEX_TEST_BINARY файл пропускается. Провал не повод ослаблять ограничения:
   предохранитель /reply просто остаётся закрытым. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {runIsolationCheck, IsolationError, checkEnv} = require('./isolation-check');
const {buildRestrictedCatalog, validateRestrictedCatalog} = require('./model-catalog');
const {PINNED_CODEX_VERSION} = require('./codex-config');

const CODEX_BINARY = (process.env.CODEX_TEST_BINARY || '').trim();
const SKIP = !CODEX_BINARY
  ? 'нужен абсолютный путь в CODEX_TEST_BINARY'
  : !path.isAbsolute(CODEX_BINARY)
    ? 'CODEX_TEST_BINARY должен быть абсолютным путём'
    : !fs.existsSync(CODEX_BINARY)
      ? 'файл CODEX_TEST_BINARY не найден'
      : false;

/* Официальный встроенный набор моделей самого бинаря: без сети, без авторизации. */
function bundledModels(codexHome) {
  return execFileSync(CODEX_BINARY, ['debug', 'models', '--bundled'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: checkEnv(codexHome),
    windowsHide: true,
  });
}

test('закреплённый Codex не объявляет инструментов и не выполняет навязанные вызовы', {skip: SKIP}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugh-isolation-'));
  t.after(() => {
    try {
      fs.rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    } catch {
      /* временный каталог уберёт система */
    }
  });

  const bootstrapHome = path.join(root, 'bootstrap');
  fs.mkdirSync(path.join(bootstrapHome, 'home'), {recursive: true});
  const catalog = buildRestrictedCatalog(bundledModels(bootstrapHome), {
    preferredSlug: (process.env.CODEX_TEST_MODEL || '').trim() || null,
  });
  const catalogPath = path.join(root, 'restricted-models.json');
  fs.writeFileSync(catalogPath, catalog.catalogText);
  assert.equal(validateRestrictedCatalog(catalog.catalogText).ok, true, 'собранный каталог обязан проходить проверку');

  const proofPath = process.env.HUGH_PROOF_OUT || path.join(root, 'tool-isolation-proof.json');
  let result;
  try {
    result = await runIsolationCheck({
      codexBinary: CODEX_BINARY,
      catalogPath,
      proofPath,
      workDir: path.join(root, 'check'),
      timeoutMs: 180_000,
    });
  } catch (error) {
    if (error instanceof IsolationError) {
      // Диагностика поддельного прогона безопасна: настоящих учётных данных здесь нет.
      assert.fail(
        `${error.message}\nвыход: ${JSON.stringify(error.diagnostics.exit)}\njournal app-server:\n${error.diagnostics.stderrTail}`,
      );
    }
    throw error;
  }

  assert.deepEqual(result.observedTools, []);
  assert.equal(result.model, catalog.slug);
  assert.equal(result.catalogSha256, catalog.sha256);
  assert.ok(fs.existsSync(proofPath), 'доказательство записано');
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  assert.equal(proof.codexVersion, PINNED_CODEX_VERSION);
  assert.equal(proof.fingerprint, result.fingerprint);
  assert.deepEqual(proof.observedTools, []);
  assert.equal(proof.injectedToolCallsExecuted, false);
  assert.equal(proof.canaryIntact, true);
  console.log(`hugh-runtime: доказательство изоляции записано в ${proofPath} (модель ${result.model})`);
});
