'use strict';

/* Ключ подписи сессий: приоритет переменной окружения, постоянство между запусками,
   отказ при повреждении и отсутствие ключа в журналах.
   node --test ops/content/session-secret.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSessionSecret, SECRET_FILE } = require('./session-secret');

const HEX64 = /^[0-9a-f]{64}$/;
const POSIX = process.platform !== 'win32';

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-secret-'));
  return { dir, databasePath: path.join(dir, 'content.sqlite'), file: path.join(dir, SECRET_FILE) };
}
// Каждый вызов — отдельный запуск процесса с теми же настройками.
function boot({ databasePath, envSecret = '', events = [] }) {
  return resolveSessionSecret({ envSecret, databasePath, onEvent: (event, details) => events.push({ event, ...details }) });
}

test('заданный SESSION_SECRET используется как есть и не создаёт файла', () => {
  const { databasePath, file } = workspace();
  const events = [];
  const result = boot({ databasePath, envSecret: '  явный-ключ-владельца  ', events });
  assert.equal(result.secret, 'явный-ключ-владельца');
  assert.equal(result.source, 'env');
  assert.equal(fs.existsSync(file), false, 'при заданной переменной файл не нужен');
  assert.deepEqual(events, []);
});

test('без переменной ключ создаётся один раз и переживает перезапуски', () => {
  const { databasePath, file } = workspace();
  const events = [];
  const first = boot({ databasePath, events });
  assert.match(first.secret, HEX64);
  assert.equal(first.source, 'file');
  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), first.secret);
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'файл читает только владелец процесса');
  for (let restart = 0; restart < 3; restart++) {
    const next = boot({ databasePath, events });
    assert.equal(next.secret, first.secret, 'перезапуск не меняет ключ');
    assert.equal(next.created, false);
  }
  assert.deepEqual(events.map((item) => item.event), ['created', 'reused', 'reused', 'reused']);
  assert.equal(events.every((item) => item.file === file), true);
  // Ключ не попадает ни в события, ни в их подробности.
  assert.equal(JSON.stringify(events).includes(first.secret), false);
});

test('переменная окружения главнее сохранённого файла и не переписывает его', () => {
  const { databasePath, file } = workspace();
  const stored = boot({ databasePath }).secret;
  const explicit = boot({ databasePath, envSecret: 'ключ-из-окружения' });
  assert.equal(explicit.secret, 'ключ-из-окружения');
  assert.equal(explicit.source, 'env');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), stored, 'файл остаётся нетронутым');
  assert.equal(boot({ databasePath }).secret, stored, 'после возврата к файлу ключ прежний');
});

test('повреждённый ключ останавливает запуск и не подменяется молча', () => {
  for (const broken of ['', '   ', 'не шестнадцатеричная строка', 'abc', 'A'.repeat(64), `${'a'.repeat(64)}extra`]) {
    const { databasePath, file } = workspace();
    fs.writeFileSync(file, broken, { mode: 0o600 });
    assert.throws(() => boot({ databasePath }), /повреждён/, `повреждение ${JSON.stringify(broken)}`);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'повреждённый файл не перезаписан');
  }
});

test('нечитаемый ключ останавливает запуск', () => {
  const { databasePath, file } = workspace();
  fs.mkdirSync(file);
  assert.throws(() => boot({ databasePath }), /ключ подписи сессий|Ключ подписи сессий/);
});

test('лишние права на файле ключа снимаются при запуске', { skip: !POSIX }, () => {
  const { databasePath, file } = workspace();
  const secret = boot({ databasePath }).secret;
  fs.chmodSync(file, 0o644);
  assert.equal(boot({ databasePath }).secret, secret);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'права возвращены к 0600');
});

test('разные базы получают разные ключи, путь базы обязателен', () => {
  const one = boot({ databasePath: workspace().databasePath }).secret;
  const two = boot({ databasePath: workspace().databasePath }).secret;
  assert.notEqual(one, two);
  assert.throws(() => resolveSessionSecret({}), /путь базы данных/);
  assert.throws(() => resolveSessionSecret({ databasePath: '   ' }), /путь базы данных/);
});

test('каталог базы создаётся, если его ещё нет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-secret-'));
  const databasePath = path.join(dir, 'data', 'content.sqlite');
  const result = boot({ databasePath });
  assert.match(result.secret, HEX64);
  assert.equal(fs.existsSync(path.join(dir, 'data', SECRET_FILE)), true);
});
