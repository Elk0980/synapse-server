'use strict';
// Проверка точных payload-байтов в собственном временном стенде. Реальная сеть не используется.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
require('./owned-temp-guard.cjs');

assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Нужен Node.js 24 или новее');
const pkg = path.resolve(__dirname, '..');
const repo = path.resolve(pkg, '..', '..');
const targets = [
  ...['server.js', 'client-dialogs.js', 'palitra-host-adapter.cjs', 'customer-chat.js',
    'customer-chat-http.cjs', 'customer-chat-native-adapter.cjs', 'customer-chat-media.cjs',
    'customer-chat-upload.cjs'].map(n => 'content/' + n),
  ...['palitra-chat.html', 'palitra-chat.js', 'palitra-chat.css'].map(n => 'content/palitra-review-public/' + n),
  ...['palitra-work.html', 'palitra-work.js', 'palitra-work.css'].map(n => 'sites/synapse/cabinet/' + n),
  'managed-site/assets/order.js', 'ops/chat/client-bot-bridge.js',
];
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'source-manifest.json'), 'utf8'));
assert.equal(manifest.approved_finished, true);
assert.deepEqual(manifest.targets.map(r => r.target).sort(), [...targets].sort());
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const realTemp = fs.realpathSync(os.tmpdir());
const tmp = fs.mkdtempSync(path.join(realTemp, 'palitra-upload-local-'));
const before = new Map();
function copyBytes(from, name) {
  const bytes = fs.readFileSync(from);
  const dest = path.join(tmp, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes, { flag: 'wx' });
  before.set(from, hash(bytes));
}
try {
  for (const row of manifest.targets) {
    assert.equal(row.source, 'payload/' + row.target);
    const source = path.join(pkg, row.source);
    const bytes = fs.readFileSync(source);
    assert.equal(bytes.length, row.bytes);
    assert.equal(hash(bytes), row.sha256);
    copyBytes(source, row.target.startsWith('ops/chat/') ? row.target : path.basename(row.target));
  }
  copyBytes(path.join(repo, 'ops/chat/quiet-hours.js'), 'BASE/quiet-hours.js');
  copyBytes(path.join(repo, 'ops/content/client-bot-config.js'), 'client-bot-config.js');
  const tests = ['web-upload.test.cjs', 'web-upload-worker.test.cjs', 'phaseE-ui.test.cjs'];
  for (const name of tests) copyBytes(path.join(__dirname, 'fixtures', name), name);
  const result = spawnSync(process.execPath, [
    '--require', path.join(__dirname, 'owned-temp-guard.cjs'), '--test',
    ...tests.map(n => path.join(tmp, n)),
  ], { cwd: tmp, env: process.env, stdio: 'inherit', timeout: 90000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Локальный стенд не прошёл');
} finally {
  for (const [file, expected] of before) assert.equal(hash(fs.readFileSync(file)), expected, 'Исходник изменился');
  assert.equal(path.dirname(tmp), realTemp);
  assert.equal(fs.realpathSync(tmp), tmp);
  assert.ok(path.basename(tmp).startsWith('palitra-upload-local-'));
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(fs.existsSync(tmp), false);
}
