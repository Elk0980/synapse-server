'use strict';

/* Сборка доверенного каталога моделей из официального встроенного набора закреплённого бинаря.

   Вход получают командой самого бинаря, без сети и авторизации:
     codex debug models --bundled > bundled-models.json
   (cli/src/main.rs:2383 — bundled_models_response, cli/src/main.rs:2404 — вывод в stdout)

   Запуск:
     node test-support/build-restricted-catalog.js --input bundled-models.json \
       --output /app/build/restricted-models.json [--slug gpt-5.5]

   Модель не выдумывается: берётся реальная запись, сохраняются слаг, инструкции, контекст
   и тарифы, ограничиваются только поля возможностей. */

const fs = require('node:fs');
const path = require('node:path');
const {buildRestrictedCatalog, APPROVED_SLUGS} = require('../model-catalog');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`неизвестный аргумент ${key}`);
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    throw new Error('нужны --input <bundled-models.json> и --output <restricted-models.json>');
  }
  const bundled = fs.readFileSync(path.resolve(args.input), 'utf8');
  const result = buildRestrictedCatalog(bundled, {preferredSlug: args.slug || null});

  fs.mkdirSync(path.dirname(path.resolve(args.output)), {recursive: true});
  fs.writeFileSync(path.resolve(args.output), result.catalogText);

  process.stdout.write(
    [
      `hugh-runtime: каталог собран для модели ${result.slug}`,
      `  согласованные слаги: ${APPROVED_SLUGS.join(', ')}`,
      `  исходный tool_mode: ${JSON.stringify(result.sourceToolMode)}`,
      `  исходные экспериментальные инструменты: ${JSON.stringify(result.sourceExperimentalTools)}`,
      `  sha256: ${result.sha256}`,
      '',
    ].join('\n'),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`hugh-runtime: сборка каталога не удалась — ${error.message}\n`);
  process.exit(1);
}
