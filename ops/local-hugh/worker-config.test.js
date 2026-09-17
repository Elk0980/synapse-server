'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {loadConfig, parseConfig, ConfigError, DEFAULT_COMPANIES} = require('./worker-config');
const {tempDir, removeDir} = require('./test-support/fakes');

const KEY = 'f'.repeat(64);

function writeConfig(dir, config, key = KEY) {
  const file = path.join(dir, 'config.json');
  fs.mkdirSync(path.join(dir, 'secret'), {recursive: true});
  if (key !== null) fs.writeFileSync(path.join(dir, 'secret', 'worker.key'), `${key}\n`);
  fs.writeFileSync(file, JSON.stringify({schema: 1, endpoint: 'https://sb.example.com/content/project-chat-worker', keyFile: 'secret/worker.key', ...config}));
  return file;
}

test('loadConfig: пути от каталога конфигурации, ключ отдельно от настроек', async () => {
  const dir = tempDir();
  try {
    const {settings, token} = loadConfig(writeConfig(dir, {model: 'gpt-5.5', jobTimeoutMs: 90000}));
    assert.equal(token, KEY);
    assert.deepEqual(settings.companies, DEFAULT_COMPANIES);
    assert.equal(settings.model, 'gpt-5.5');
    assert.equal(settings.jobTimeoutMs, 90000);
    assert.equal(settings.heartbeatIntervalMs, 20000);
    assert.equal(settings.renewIntervalMs, 20000);
    assert.equal(settings.allowInsecureLoopback, false);
    assert.equal(settings.codexBinary, path.join(dir, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    assert.equal(settings.statusPath, path.join(dir, 'state', 'status.json'));
    assert.equal(settings.keyFile, path.join(dir, 'secret', 'worker.key'));
    assert.ok(!JSON.stringify(settings).includes(KEY));
    assert.ok(Object.isFrozen(settings));
  } finally {
    await removeDir(dir);
  }
});

test('loadConfig: понятные коды ошибок без сырых данных', async () => {
  const dir = tempDir();
  try {
    const expectCode = (file, code) => assert.throws(() => loadConfig(file), (error) => error instanceof ConfigError && error.code === code, code);
    expectCode(path.join(dir, 'absent.json'), 'config_missing');
    expectCode(writeConfig(dir, {}, null), 'key_file_missing');
    expectCode(writeConfig(dir, {}, 'short'), 'key_invalid');
    expectCode(writeConfig(dir, {}, 'x'.repeat(40) + ' has space'), 'key_invalid');
    expectCode(writeConfig(dir, {unknown: 1}), 'config_unknown_key');
    expectCode(writeConfig(dir, {endpoint: 'http://sb.example.com/content/project-chat-worker'}), 'endpoint_not_https');
    expectCode(writeConfig(dir, {endpoint: 'https://sb.example.com/other'}), 'endpoint_path_mismatch');
    expectCode(writeConfig(dir, {companies: []}), 'companies_invalid');
    expectCode(writeConfig(dir, {companies: ['bad company']}), 'companies_invalid');
    expectCode(writeConfig(dir, {schema: 2}), 'config_schema');
    expectCode(writeConfig(dir, {jobTimeoutMs: 1}), 'jobTimeoutMs_invalid');
    expectCode(writeConfig(dir, {model: 'gpt 5'}), 'model_invalid');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    expectCode(path.join(dir, 'broken.json'), 'config_unparsable');
  } finally {
    await removeDir(dir);
  }
});

test('parseConfig: loopback HTTP только с явным флагом; несколько компаний без дублей', () => {
  const base = {schema: 1, keyFile: 'k', endpoint: 'http://127.0.0.1:9/content/project-chat-worker'};
  assert.throws(() => parseConfig(base, '/x'), (error) => error.code === 'endpoint_not_https');
  const settings = parseConfig({...base, allowInsecureLoopback: true, companies: ['palitra-love', 'palitra-love', 'demo']}, '/x');
  assert.equal(settings.allowInsecureLoopback, true);
  assert.deepEqual(settings.companies, ['palitra-love', 'demo']);
  assert.throws(() => parseConfig({...base, allowInsecureLoopback: 'yes'}, '/x'), (error) => error.code === 'allowInsecureLoopback_invalid');
  assert.throws(() => parseConfig([], '/x'), (error) => error.code === 'config_not_object');
});
