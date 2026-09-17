'use strict';

/* Проверка хранилища доверенных корней в собранном образе. Выполняется при сборке от
   рабочего пользователя и повторяется в CI на готовом образе. Ни сети, ни учётных данных:
   файл только читается и разбирается.

   Запуск:
     node test-support/check-ca-bundle.js [--path /etc/ssl/certs/ca-certificates.crt] [--minValid 20] */

const {checkCaBundle, DEFAULT_CA_BUNDLE_PATH} = require('../ca-bundle');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`неизвестный аргумент ${key}`);
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const result = checkCaBundle({
  path: args.path || DEFAULT_CA_BUNDLE_PATH,
  ...(args.minValid === undefined ? {} : {minValid: Number(args.minValid)}),
});

if (!result.ok) {
  process.stderr.write(
    [
      `hugh-runtime: хранилище корневых сертификатов не подтверждено — ${result.reason}`,
      `  файл: ${result.path}${result.code ? ` (${result.code})` : ''}`,
      `  байт: ${result.bytes}, блоков PEM: ${result.blocks}, разобрано: ${result.parsed},` +
        ` действующих: ${result.valid} (нужно ${result.minValid})`,
      '  Без доверенных корней TLS-соединение с auth.openai.com не устанавливается.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stdout.write(
  [
    'hugh-runtime: хранилище корневых сертификатов на месте и читается',
    `  файл: ${result.path} (${result.bytes} байт)`,
    `  сертификатов разобрано: ${result.parsed}, действующих сегодня: ${result.valid}, просроченных: ${result.expired}`,
    '',
  ].join('\n'),
);
