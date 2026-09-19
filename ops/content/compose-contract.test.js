'use strict';
/* Контракт docker-compose для сервиса content: резерв ответов Хью и лимит видео попадают в контейнер только через
   явный перечень переменных — без env_file и без проброса остальных секретов .env (например, TELEGRAM_BOT_TOKEN).
   node --test ops/content/compose-contract.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readProviders } = require('./hugh-fallback');

const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8').split(/\r?\n/);
function serviceBlock(name) {
  const start = compose.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `нет сервиса ${name}`);
  const body = [];
  for (let i = start + 1; i < compose.length; i += 1) {
    const line = compose[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length <= 2) break;
    body.push(line);
  }
  return body;
}
const envOf = (block) => {
  const start = block.indexOf('    environment:');
  assert.ok(start >= 0, 'у сервиса нет environment');
  const vars = {};
  for (let i = start + 1; i < block.length; i += 1) {
    const match = /^ {6}([A-Z0-9_]+): (.*)$/.exec(block[i]);
    if (!match) break;
    vars[match[1]] = match[2];
  }
  return vars;
};

test('content получает все переменные резерва Хью и флаги явным перечнем, с пустыми значениями по умолчанию', () => {
  const block = serviceBlock('content');
  assert.ok(!block.some((line) => /^\s+env_file:/.test(line)), 'env_file для content не используется: остальные секреты .env в контейнер не попадают');
  const env = envOf(block);
  const expected = ['HUGH_FALLBACK_PROVIDERS', 'HUGH_FALLBACK_OPENROUTER_URL', 'HUGH_FALLBACK_OPENROUTER_KEY', 'HUGH_FALLBACK_OPENROUTER_MODEL', 'HUGH_FALLBACK_OPENROUTER_TIMEOUT_MS',
    'HUGH_FALLBACK_DEEPSEEK_URL', 'HUGH_FALLBACK_DEEPSEEK_KEY', 'HUGH_FALLBACK_DEEPSEEK_MODEL', 'HUGH_FALLBACK_DEEPSEEK_TIMEOUT_MS',
    'HUGH_FALLBACK_LOCAL_OFFLINE_MINUTES', 'HUGH_ACK_WHEN_UNAVAILABLE', 'MAX_PUBLISHING_VIDEO_BYTES', 'TELEGRAM_BOT_USERNAME', 'CABINET_PUBLIC_URL',
    // Без этих переменных бюджетный стоп и хранилище ключей провайдеров остаются выключенными в контейнере навсегда.
    'HUGH_FALLBACK_OPENROUTER_USD_PER_1K_PROMPT', 'HUGH_FALLBACK_OPENROUTER_USD_PER_1K_COMPLETION',
    'HUGH_FALLBACK_DEEPSEEK_USD_PER_1K_PROMPT', 'HUGH_FALLBACK_DEEPSEEK_USD_PER_1K_COMPLETION',
    'HUGH_FALLBACK_BUDGET_USD', 'HUGH_FALLBACK_BUDGET_MAX_REQUESTS', 'HUGH_FALLBACK_BUDGET_WINDOW_DAYS',
    'HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS', 'HUGH_PROVIDER_MASTER_KEY', 'HUGH_PROVIDER_ALLOWED_HOSTS',
    'HUGH_SKILLS', 'HUGH_SKILLS_MAX_BYTES'];
  for (const name of expected) {
    assert.ok(Object.hasOwn(env, name), `не проброшена ${name}`);
    assert.match(env[name], new RegExp(`^\\$\\{${name}:-[^}]*\\}$`), `${name} должна браться из .env сервера с пустым/безопасным значением по умолчанию`);
  }
  assert.equal(env.HUGH_FALLBACK_LOCAL_OFFLINE_MINUTES, '${HUGH_FALLBACK_LOCAL_OFFLINE_MINUTES:-0}', 'подхват локальных компаний по умолчанию выключен');
  assert.equal(env.HUGH_ACK_WHEN_UNAVAILABLE, '${HUGH_ACK_WHEN_UNAVAILABLE:-0}');
  // Мастер-ключ приходит только из окружения сервера: значения в репозитории нет, пустое значение = хранилище закрыто.
  assert.equal(env.HUGH_PROVIDER_MASTER_KEY, '${HUGH_PROVIDER_MASTER_KEY:-}', 'мастер-ключ берётся из .env сервера и по умолчанию пуст');
  assert.ok(!compose.some((line) => /^\s+[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*:\s*[^$\s]/.test(line)),
    'ни один ключ, секрет или токен не записан в compose значением: только ссылка на .env сервера');
  for (const forbidden of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'MODEL_API_KEY', 'ONLYPULT'])
    assert.ok(!Object.keys(env).some((name) => name.includes(forbidden)), `${forbidden} не должен пробрасываться в content`);
  // Имена провайдеров в compose совпадают с тем, что читает код: перечень HUGH_FALLBACK_PROVIDERS ограничен openrouter,deepseek.
  const sample = Object.fromEntries(expected.map((name) => [name, '']));
  Object.assign(sample, { HUGH_FALLBACK_PROVIDERS: 'openrouter,deepseek', HUGH_FALLBACK_OPENROUTER_URL: 'https://x', HUGH_FALLBACK_OPENROUTER_KEY: 'k', HUGH_FALLBACK_OPENROUTER_MODEL: 'm',
    HUGH_FALLBACK_DEEPSEEK_URL: 'https://y', HUGH_FALLBACK_DEEPSEEK_KEY: 'k', HUGH_FALLBACK_DEEPSEEK_MODEL: 'm' });
  assert.deepEqual(readProviders(sample).providers.map((p) => p.name), ['openrouter', 'deepseek']);
  const example = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  for (const name of expected.filter((n) => n.startsWith('HUGH_'))) assert.ok(example.includes(`${name}=`) || name.endsWith('_TIMEOUT_MS'), `${name} должна быть в .env.example`);
  assert.ok(!/HUGH_FALLBACK_[A-Z]+_KEY=\S/.test(example), 'в .env.example нет значений ключей');
  assert.ok(!/HUGH_PROVIDER_MASTER_KEY=\S/.test(example), 'в .env.example нет значения мастер-ключа');
});

test('chat получает имя бота для команд Хью явным перечнем, токен бота в content не пробрасывается', () => {
  const chat = envOf(serviceBlock('chat'));
  assert.equal(chat.TELEGRAM_BOT_USERNAME, '${TELEGRAM_BOT_USERNAME:-}');
  assert.ok(Object.hasOwn(chat, 'TELEGRAM_BOT_TOKEN'));
  const content = envOf(serviceBlock('content'));
  assert.ok(!Object.hasOwn(content, 'TELEGRAM_BOT_TOKEN'));
});
