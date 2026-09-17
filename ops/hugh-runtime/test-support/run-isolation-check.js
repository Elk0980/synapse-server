'use strict';

/* Запуск проверки изоляции на настоящем закреплённом бинаре с локальным mock-провайдером.
   Выполняется при сборке образа от непривилегированного пользователя и вживую владельцем.
   Провал останавливает сборку: предохранитель /reply остаётся закрытым.

   Запуск:
     node test-support/run-isolation-check.js --binary /usr/local/bin/codex \
       --catalog /app/build/restricted-models.json --proof /app/build/tool-isolation-proof.json */

const {runIsolationCheck, IsolationError} = require('../isolation-check');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`неизвестный аргумент ${key}`);
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.binary || !args.catalog || !args.proof) {
    throw new Error('нужны --binary, --catalog и --proof');
  }
  const result = await runIsolationCheck({
    codexBinary: args.binary,
    catalogPath: args.catalog,
    proofPath: args.proof,
    timeoutMs: Number(args.timeoutMs || 180_000),
  });
  process.stdout.write(
    [
      'hugh-runtime: изоляция подтверждена на закреплённом бинаре',
      `  модель: ${result.model}`,
      `  инструментов объявлено: ${result.observedTools.length}`,
      `  статус хода: ${result.turnStatus}`,
      `  навязано вызовов: ${result.injectedCalls}, подтверждённых отказов: ${result.rejectedToolCalls}`,
      `  список MCP проверен: ${result.mcpChecked}`,
      `  запросов к mock-провайдеру: ${result.providerRequests}`,
      `  отпечаток: ${result.fingerprint}`,
      `  доказательство: ${result.proofPath}`,
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  process.stderr.write(`hugh-runtime: изоляция НЕ подтверждена — ${error.message}\n`);
  if (error instanceof IsolationError) {
    // Провайдер поддельный, ключ тестовый: диагностика здесь безопасна и нужна для разбора.
    process.stderr.write(`  выход процесса: ${JSON.stringify(error.diagnostics.exit)}\n`);
    process.stderr.write(`  журнал app-server (обрезан):\n${error.diagnostics.stderrTail || '(пусто)'}\n`);
  }
  process.exit(1);
});
