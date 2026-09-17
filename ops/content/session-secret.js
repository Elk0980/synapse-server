'use strict';

/* Ключ подписи сессий кабинета.

   SESSION_SECRET из окружения имеет приоритет и используется как есть.
   Если переменная не задана, ключ берётся из приватного файла рядом с базой данных:
   случайный ключ на каждый запуск выбрасывал бы владельца из кабинета при каждом
   перезапуске сервиса. Файл создаётся один раз с правами 0600 и только для владельца процесса.

   Значение никогда не попадает в журналы, ответы API и каталог статики.
   Повреждённый или недоступный файл — отказ запуска: молча заменять ключ нельзя,
   это обнулило бы все подписи без ведома владельца. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SECRET_FILE = 'session-secret.key';
const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const fail = (message) => { throw new Error(message); };

function readSecret(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`Не удалось прочитать ключ подписи сессий ${file}: ${error.code || 'ошибка чтения'}`);
  }
  const value = raw.trim();
  if (!SECRET_PATTERN.test(value)) {
    fail(`Ключ подписи сессий ${file} повреждён: ожидались 64 шестнадцатеричных символа. ` +
      'Проверьте файл; удаление ключа потребует повторного входа всех пользователей');
  }
  return value;
}

// Ключ читает только владелец процесса. Лишние права снимаем, а если не вышло — не запускаемся.
function restrictAccess(file) {
  if (process.platform === 'win32') return;
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (error) {
    fail(`Не удалось проверить права ключа подписи сессий ${file}: ${error.code || 'ошибка чтения'}`);
  }
  if (!(mode & 0o077)) return;
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    fail(`Ключ подписи сессий ${file} доступен другим пользователям, права не удалось ограничить: ${error.code || 'ошибка'}`);
  }
}

// Создание исключительное: гонка двух процессов заканчивается чтением уже созданного ключа.
function createSecret(file) {
  const value = crypto.randomBytes(32).toString('hex');
  let handle;
  try {
    handle = fs.openSync(file, 'wx', 0o600);
    fs.writeSync(handle, value);
    fs.fsyncSync(handle);
    return value;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    fail(`Не удалось создать ключ подписи сессий ${file}: ${error.code || 'ошибка записи'}`);
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* уже закрыт */ } }
  }
}

function resolveSessionSecret({ envSecret = '', databasePath = '', onEvent = () => {} } = {}) {
  const explicit = String(envSecret || '').trim();
  if (explicit) return { secret: explicit, source: 'env' };
  if (!String(databasePath).trim()) fail('Не задан путь базы данных: негде хранить ключ подписи сессий');
  const directory = path.dirname(path.resolve(databasePath));
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail(`Не удалось подготовить каталог ${directory} для ключа подписи сессий: ${error.code || 'ошибка'}`);
  }
  const file = path.join(directory, SECRET_FILE);
  const existing = readSecret(file);
  if (existing) {
    restrictAccess(file);
    onEvent('reused', { file });
    return { secret: existing, source: 'file', file, created: false };
  }
  const created = createSecret(file);
  if (created) {
    onEvent('created', { file });
    return { secret: created, source: 'file', file, created: true };
  }
  const raced = readSecret(file);
  if (!raced) fail(`Ключ подписи сессий ${file} исчез сразу после создания`);
  restrictAccess(file);
  onEvent('reused', { file });
  return { secret: raced, source: 'file', file, created: false };
}

module.exports = { resolveSessionSecret, SECRET_FILE, SECRET_PATTERN };
