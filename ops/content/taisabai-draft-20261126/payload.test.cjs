'use strict';
// Проверка пакета черновика ТайСабай перед выпуском (№329). Запуск:
//   node --test ops/content/taisabai-draft-20261126/payload.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = path.join(__dirname, 'payload');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const walk = (d, p = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), p + e.name + '/') : [p + e.name]);
const files = walk(DIR).filter((f) => f !== 'SHA256SUMS');

// Те же правила пути и типов, что у site-workspaces на сервере.
const TYPES = new Set(['.html', '.json', '.jpg', '.webp', '.mp4']);
const validPath = (v) => v.length <= 240 && !v.startsWith('/') &&
  v.split('/').every((part) => part && !part.startsWith('.') && /^[\w .@()Ѐ-ӿ-]+$/.test(part)) &&
  TYPES.has(path.extname(v).toLowerCase());

test('SHA256SUMS совпадает с файлами пакета', () => {
  const sums = fs.readFileSync(path.join(DIR, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split('  '));
  assert.strictEqual(sums.length, files.length);
  for (const [sha, f] of sums) {
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex'), sha, f);
  }
});

test('пути принимаются хранилищем черновиков; размер в пределах 512 МБ', () => {
  assert.deepStrictEqual(files.filter((f) => !validPath(f)), []);
  const total = files.reduce((n, f) => n + fs.statSync(path.join(DIR, f)).size, 0);
  assert.ok(total < 512 * 1024 * 1024, String(total));
});

test('черновик закрыт от индексации, один H1, есть title и description', () => {
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<html lang="ru">/);
  assert.strictEqual((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{50,}">/);
  assert.doesNotMatch(html, /artifact-thumbnail|claude:viewport/);
});

test('на сайте нет прямых контактов Golden Key (лиды идут к нам)', () => {
  const all = html + fs.readFileSync(path.join(DIR, 'flats.json'), 'utf8');
  assert.doesNotMatch(all, /584\s?9368|goldenkeyproperty\.th@|t\.me\/(?!TaiSabai_community)[A-Za-z]/i);
});

test('все локальные файлы, на которые ссылается страница, есть в пакете', () => {
  const refs = [...html.matchAll(/(?:src|href|poster)="((?:v|views|img|r)\/[^"$]+)"/g)].map((m) => m[1]);
  const flats = JSON.parse(fs.readFileSync(path.join(DIR, 'flats.json'), 'utf8'));
  for (const o of flats) {
    if (o.video) refs.push(`v/${o.video}.mp4`, `v/${o.video}.jpg`);
    for (const i of o.imgs || []) refs.push(i.startsWith('img/') ? i : `img/${i}`);
  }
  const missing = [...new Set(refs)].filter((r) => !files.includes(r));
  assert.deepStrictEqual(missing, []);
});
