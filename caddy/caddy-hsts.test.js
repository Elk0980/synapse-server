'use strict';
// node --test caddy/caddy-hsts.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'Caddyfile'), 'utf8');

// Верхнеуровневые блоки: имя → тело (комментарии отброшены).
function blocks() {
  const result = [];
  let depth = 0, current = null;
  for (const raw of source.split('\n')) {
    const line = raw.trim().startsWith('#') ? '' : raw;
    if (depth === 0 && line.trim().endsWith('{')) current = { name: line.trim().slice(0, -1).trim(), body: [] };
    if (current) current.body.push(line);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth === 0 && current) { result.push({ ...current, body: current.body.join('\n') }); current = null; }
  }
  return result;
}

test('snippet hsts: сутки, без includeSubDomains и preload', () => {
  const hsts = blocks().find((b) => b.name === '(hsts)');
  assert.ok(hsts, 'нет сниппета (hsts)');
  assert.match(hsts.body, /header Strict-Transport-Security "max-age=86400"\n/);
  assert.doesNotMatch(source.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /includeSubDomains|preload/i);
  assert.match(blocks().find((b) => b.name === '(static)').body, /import hsts/);
});

test('каждый домен отдаёт HSTS через static, palitra_site или напрямую', () => {
  const sites = blocks().filter((b) => b.name && !b.name.startsWith('('));
  assert.ok(sites.length >= 20, 'разбор Caddyfile нашёл слишком мало блоков');
  for (const site of sites) {
    assert.match(site.body, /import (hsts|static|palitra_site)\b/, `${site.name} без HSTS`);
  }
  assert.match(blocks().find((b) => b.name === '(palitra_site)').body, /import static/);
});
